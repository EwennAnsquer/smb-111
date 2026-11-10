# Quinzo : choix d'architecture

## Problème
Une partie de quiz est un **état partagé et vivant** : joueurs, question en cours, chrono, réponses, scores. Dans la première version, cet état était un objet en mémoire dans un seul processus Node.js. Avec deux pods derrière un répartiteur, un joueur arrivé sur le pod B ne voyait pas la partie créée sur le pod A. Le chart forçait donc `replicas: 1`.

## Options étudiées

| Option | Pour | Contre | Retenue |
|---|---|---|---|
| Garder 1 réplica | simple | pas de haute disponibilité ni de vraie répartition de charge | ❌ |
| 2 instances indépendantes | aucun changement de code | deux parties séparées : ce n'est pas la répartition d'**une même** appli | ❌ |
| **État externalisé dans Redis + adaptateur Socket.IO + sessions collantes** | vrais réplicas interchangeables, bascule automatique, mises à jour sans coupure | plus de code, une dépendance (Redis) | ✅ |

## Solution retenue

### 1. État de partie dans Redis
- L'état de la partie est un document JSON sous la clé `quinzo:game`. Il est **sérialisable** : les questions tirées sont copiées dedans au lancement, si bien qu'un pod n'a besoin d'aucune donnée locale pour poursuivre une partie.
- La logique de jeu (`lib/game.js`) est faite de **fonctions pures** qui reçoivent cet état et le modifient. Elles ne contiennent aucun minuteur ni accès réseau, ce qui les rend testables et exécutables par n'importe quel pod.
- Chaque action (réponse, inscription, question suivante…) suit le même cycle **verrou → lecture → modification → écriture** :
  - le verrou distribué est un `SET quinzo:lock <jeton> NX PX 5000`, libéré par un script Lua qui vérifie le jeton ;
  - c'est ce qui évite les pertes de mise à jour quand 40 joueurs répondent en même temps sur deux pods. Ce cas est testé : 40 réponses sur 40 comptées.

### 2. Diffusion entre pods : adaptateur Socket.IO Redis
- `@socket.io/redis-adapter` relaie par pub/sub Redis les émissions vers les salles (`host`, `p:<idJoueur>`). Il gère aussi `fetchSockets()` et `serverSideEmit()` à l'échelle du cluster.
- Après chaque modification, le pod concerné émet `quinzo:changed`. Chaque pod relit alors l'état et envoie **à ses propres clients** leur vue personnalisée. Un joueur ne reçoit jamais les réponses des autres avant la révélation.

### 3. Échéances : un « leader » élu dans Redis
- Le chrono, l'enchaînement automatique et le ménage du salon ne sont pas des `setTimeout`. Ce sont des **horodatages stockés dans l'état** (`endsAt`, `revealAt`, `autoNextAt`).
- Un seul pod, le leader, les traite toutes les 200 ms. Il détient un bail `SET quinzo:leader <instance> NX PX 6000`, renouvelé toutes les 2 s par script Lua.
- Si le leader meurt, son bail expire et un autre pod le reprend. Comme les échéances sont dans Redis, rien n'est perdu. Testé : `kill -9` du leader en pleine question, la révélation a lieu 6,7 s plus tard sur l'autre pod.
- Le leader **réconcilie aussi la présence** toutes les 10 s avec `fetchSockets()` sur tout le cluster. Un pod qui plante n'envoie pas de « déconnexion » : sans cette réconciliation, ses joueurs resteraient affichés comme connectés pour toujours.

### 4. Sessions collantes (sticky sessions)
- Socket.IO commence parfois en **HTTP long-polling** : plusieurs requêtes successives qui doivent arriver au même pod, qui détient la session Engine.IO. L'Ingress pose donc un cookie d'affinité (`quinzo_sticky`) :
  - ingress-nginx : annotations `nginx.ingress.kubernetes.io/affinity: cookie` sur l'Ingress ;
  - Traefik (k3s) : annotations `traefik.ingress.kubernetes.io/service.sticky.cookie` sur le Service ;
  - accès direct en NodePort ou LoadBalancer : `sessionAffinity: ClientIP` sur le Service.
- En complément, le client essaie **WebSocket en premier** (`transports: ['websocket', 'polling']`). Une seule connexion longue reste naturellement sur un pod, et l'affinité n'est indispensable qu'en cas de repli en long-polling.
- Si un pod disparaît, le client se reconnecte sur un autre et se réinscrit avec son identifiant (gardé dans `localStorage`). Son score est conservé puisqu'il est dans Redis.

### 5. Thèmes et compte admin partagés
- Les thèmes sont dans le hash `quinzo:themes`, avec un compteur de version `quinzo:themes:ver`. Chaque pod garde un cache qu'il recharge quand la version change : un thème créé via le pod A est immédiatement utilisable sur le pod B.
- Les sessions admin sont stockées sous `quinzo:sess:<sha256(jeton)>` avec un TTL de 12 h. On peut se connecter sur un pod et agir sur un autre.

### 6. Authentification de l'administrateur (facultative)
- **Désactivée par défaut** : l'écran hôte et l'éditeur sont en accès libre, ce qui convient à une soirée entre amis sur un réseau domestique. Elle s'active avec `ADMIN_PASSWORD` (ou `admin.enabled=true` dans le chart).
- Une fois activée, la page `/login` attend un identifiant et un mot de passe. Les pages `/host` et `/editor` ainsi que les API d'administration exigent une session valide, et **rien n'est servi sans elle**.
- Le mot de passe est **haché avec scrypt** (sel aléatoire), et la comparaison se fait en temps constant. En Kubernetes, il vient d'un Secret (généré par le chart s'il n'est pas fourni).
- La session est un jeton aléatoire de 256 bits, envoyé dans un cookie `HttpOnly` + `SameSite=Strict` (et `Secure` en HTTPS). Seule son empreinte SHA-256 est stockée dans Redis.
- **CSRF** :
  - en-tête `X-Quinzo` obligatoire sur les requêtes qui modifient quelque chose ;
  - vérification de l'en-tête `Origin` à la connexion WebSocket de l'hôte ;
  - en-têtes `Content-Security-Policy` et `X-Frame-Options: DENY`.
- **Force brute** : 10 échecs par IP et par quart d'heure (IP réelle lue dans `X-Forwarded-For` derrière l'Ingress), plus un ralentissement global au-delà de 30 échecs. Les compteurs sont dans Redis, donc partagés entre pods.
- **Révocation** : un changement de mot de passe incrémente une « époque », ce qui invalide toutes les autres sessions. La déconnexion coupe les WebSockets de la session sur tous les pods.

## Ce qui reste volontairement simple
- **Redis intégré en une seule instance** (StatefulSet + AOF + PVC) : c'est le point unique de défaillance de la solution. Pour la production, il faut un Redis managé ou un Redis Sentinel/Cluster via `externalRedis.url`.
- **Verrou global** : toutes les écritures sont sérialisées. C'est largement suffisant pour une partie de 50 joueurs (une écriture prend environ 1 ms), mais ce ne serait pas adapté à des milliers de parties simultanées. Il faudrait alors un verrou et une clé par partie.
- Les horloges des nœuds doivent être synchronisées (NTP), car les chronos reposent sur des horodatages.

## Tests réalisés
- 2 instances sur le même Redis, avec l'hôte sur B et des joueurs sur A et B : inscription, partie, révélation anticipée et résultats personnels.
- `kill -9` du pod leader en pleine question : un joueur revient sur l'autre pod sans code, garde son score et retrouve la question. La révélation a lieu à la fin du chrono et l'autre pod devient leader.
- 40 réponses simultanées réparties sur 2 instances : 40/40 comptées.
- Connexion admin (quand elle est activée) : refus sans session, sans en-tête anti-CSRF, ou avec un mauvais mot de passe ; session partagée entre pods ; la déconnexion invalide la session.
- Chart : `helm lint`, puis rendu de 6 configurations validées contre les schémas Kubernetes 1.31 ; refus de `replicaCount > 1` sans Redis.
