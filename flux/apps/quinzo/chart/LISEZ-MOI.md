# 🎉 Quinzo : le quiz entre potes en réseau local

Ton PC héberge la partie, tes potes jouent depuis leur PC ou leur téléphone, sur le même Wi-Fi. Pas de compte, pas d'internet nécessaire pendant la partie.

## 🚀 Démarrage (Windows)

1. Installe **Node.js** (version LTS) depuis https://nodejs.org. C'est à faire une seule fois.
2. Dézippe le dossier `quinzo` où tu veux.
3. Double-clique sur **`Lancer Quinzo.bat`**.
   - L'écran hôte s'ouvre tout seul dans ton navigateur (`http://localhost:3000/host`). La page des joueurs a aussi un bouton **🖥️ Écran hôte** qui y mène.
   - La fenêtre noire affiche l'adresse à donner à tes potes, par exemple `http://192.168.1.42:3000`, et le **code de la partie** (4 chiffres). Laisse-la ouverte pendant la partie.
4. La première fois, Windows demande d'autoriser Node.js dans le pare-feu : coche **Réseaux privés** et valide.

Sur Mac ou Linux : `./lancer.sh` (ou `npm start`).

### Tes potes n'arrivent pas à se connecter ?
- Vérifie qu'ils sont bien sur **le même Wi-Fi / la même box** (pas en 4G, pas sur le Wi-Fi invité).
- Dans Windows : *Paramètres → Réseau et Internet → Wi-Fi → ton réseau →* **Profil réseau : Privé**.
- Sinon, lance **`Autoriser-pare-feu.bat`** (il demande les droits administrateur). Il ouvre le port 3000 **uniquement sur les réseaux privés**. Après la partie, lance **`Retirer-pare-feu.bat`** pour refermer.
- Si plusieurs adresses s'affichent (VPN, VirtualBox…), essaie les autres.

## 🐳 Avec Docker (alternative)

Si tu préfères Docker à l'installation de Node.js :

1. Installe et démarre **Docker Desktop** (https://www.docker.com/products/docker-desktop/).
2. Double-clique sur **`Docker - Lancer.bat`** (Mac/Linux : `./docker-lancer.sh`).
   - La première fois, le conteneur se construit (environ une minute).
   - Le lanceur détecte l'adresse de ton PC sur le Wi-Fi et ouvre l'écran hôte.
3. Pour arrêter : **`Docker - Arreter.bat`** (ou `docker compose down`).

Ce qui change avec Docker :
- **Tes thèmes sont dans le dossier `data/`** : ils sont conservés quand tu reconstruis ou supprimes le conteneur. Les 10 thèmes fournis y sont copiés au premier lancement.
- **Si l'adresse affichée aux joueurs est fausse ou absente**, clique sur **✏️ Adresse** sur l'écran hôte et tape l'IP de ton PC (par exemple `192.168.1.42`). Tu peux aussi la fixer avec la variable `PUBLIC_HOST`.
- **Retirer un joueur génère automatiquement un nouveau code**, au lieu de bannir son appareil. Avec Docker Desktop, tous les joueurs semblent venir de la même adresse, donc le serveur ne peut pas les distinguer. Pour la même raison, après 20 codes faux en une minute, le code change tout seul et les entrées sont bloquées 30 secondes.
- Le conteneur **ne redémarre pas tout seul** quand tu rallumes ton PC : il ne tourne que quand tu le lances.
- Autre port : `set QUINZO_PORT=8080` avant le lanceur. Code fixe : `set PIN=2468`.

## ☸️ Sur Kubernetes (chart Helm, plusieurs réplicas)

Le chart `helm/quinzo` déploie Quinzo sur **plusieurs réplicas** (2 par défaut) avec un Redis intégré :
- l'état de la partie, les sessions admin et les thèmes sont dans Redis ;
- Socket.IO relaie les messages entre pods ;
- un pod « leader » gère le chrono, avec relève automatique ;
- les sessions sont collantes au niveau de l'Ingress.

```bash
docker build -t <registre>/quinzo:1.1.0 . && docker push <registre>/quinzo:1.1.0
helm install quinzo ./helm/quinzo -n quinzo --create-namespace \
  --set image.repository=<registre>/quinzo --set ingress.enabled=true --set ingress.host=quiz.maison.lan
```

Toutes les options sont détaillées dans `helm/quinzo/README.md`, et les choix d'architecture dans `docs/ARCHITECTURE.md`.

## 🎮 Jouer

- **Écran hôte** (`/host`), sur ton PC, idéalement branché à la télé : choix des thèmes, du nombre de questions, du temps, de la difficulté et des types de questions. Il affiche les questions, les réponses et le classement.
- **Joueurs** : ils ouvrent l'adresse affichée et tapent le **code** affiché sur l'écran hôte. S'ils scannent le QR code, le code est rempli tout seul. Ils choisissent ensuite un pseudo et un avatar. Pour jouer toi aussi, ouvre `http://localhost:3000` dans un autre onglet ou sur ton téléphone.
- Raccourcis de l'écran hôte : **Espace / Entrée** pour lancer, révéler ou passer à la suite, **F** pour le plein écran.
- À chaque révélation, chacun voit sur son écran **ce que tout le monde a répondu** : la répartition des votes, qui a choisi quoi et les points de chacun. Pendant la question, on voit seulement qui a déjà répondu, pas la réponse, pour éviter la triche.
- Si un joueur perd la connexion (écran verrouillé…), il revient automatiquement avec son score.

### Types de questions
| Type | Ce que fait le joueur | Points |
|---|---|---|
| 🔠 QCM (2 à 6 choix) | touche la bonne réponse | 500 à 1000 selon la rapidité |
| ⚖️ Vrai / Faux | Vrai ou Faux | 500 à 1000 selon la rapidité |
| 🎯 Estimation | curseur ou valeur exacte | jusqu'à 1000 selon la proximité |
| 🔢 Remettre dans l'ordre | touche les éléments dans l'ordre | points partiels, bonus de rapidité si tout est bon |
| ⌨️ Réponse libre | tape la réponse (fautes de frappe et accents tolérés) | 500 à 1000 selon la rapidité |

🔥 Série de bonnes réponses : +50 points par bonne réponse d'affilée (bonus plafonné à +250).

## 📚 Thèmes et questions

10 thèmes et environ 200 questions sont fournis. Tu peux en ajouter de trois façons :

### 1. L'éditeur (le plus simple)
Bouton **✏️ Thèmes & questions** sur l'écran hôte (ou `http://localhost:3000/editor`). Tu peux y créer ou modifier des thèmes, ajouter, dupliquer ou réordonner des questions, et exporter un thème.

### 2. Importer un fichier CSV (Excel, Google Sheets…)
Dans l'éditeur, clique sur **⬇️ Modèle CSV**, remplis-le, puis glisse le fichier dans la zone d'import. Colonnes :

| colonne | rôle |
|---|---|
| `theme` | nom du thème (un même fichier peut en contenir plusieurs) |
| `emoji` | emoji du thème (facultatif) |
| `type` | `qcm`, `vraifaux`, `estimation`, `ordre` ou `texte` |
| `question` | l'intitulé |
| `reponse` | QCM : le texte de la bonne réponse · vrai/faux : `vrai` ou `faux` · estimation : le nombre · ordre : les éléments dans le bon ordre séparés par `\|` · texte : les réponses acceptées séparées par `\|` |
| `options` | QCM : les mauvaises réponses séparées par `\|` (les choix sont mélangés) |
| `difficulte` | `facile`, `moyen` ou `difficile` |
| `explication` | affichée après la réponse (facultatif) |
| `unite`, `min`, `max` | pour les estimations (facultatif ; `min`/`max` affichent un curseur) |

Le séparateur (`;` ou `,`) est détecté automatiquement. Si tu importes un thème qui existe déjà, ses questions sont **ajoutées** au thème existant, sans doublons.

### 3. Fichiers JSON
Chaque fichier `.json` du dossier `themes/` est un thème. Tu peux les copier ou les partager, puis cliquer sur **🔄 Relire dossier** dans l'éditeur.

```json
{
  "name": "Mon thème", "emoji": "🎲", "description": "…",
  "questions": [
    { "type": "qcm", "question": "Capitale de l'Australie ?", "choices": ["Sydney", "Canberra", "Perth"], "answer": 1, "difficulty": "moyen", "explanation": "…" },
    { "type": "vraifaux", "question": "Le Soleil est une étoile.", "answer": true },
    { "type": "estimation", "question": "Année de la prise de la Bastille ?", "answer": 1789, "min": 1700, "max": 1900 },
    { "type": "estimation", "question": "Hauteur de la tour Eiffel ?", "answer": 330, "unit": "m" },
    { "type": "ordre", "question": "Du plus petit au plus grand", "items": ["Souris", "Chat", "Cheval"], "details": ["20 g", "4 kg", "500 kg"] },
    { "type": "texte", "question": "Symbole chimique de l'or ?", "answer": ["Au"] }
  ]
}
```
Champs facultatifs pour toutes les questions : `difficulty`, `explanation`, `image` (une URL, ou `/images/photo.jpg` pour un fichier placé dans `themes/images/`) et `time` (temps en secondes propre à cette question).

### 🤖 Générer un thème avec une IA
Dans l'éditeur, le bouton **🤖 Prompt IA** donne un texte prêt à coller dans ChatGPT ou Claude. Colle ensuite le JSON obtenu dans la même fenêtre et il est importé directement. Pense à relire les réponses : une IA peut se tromper.

## 🔒 Sécurité (Wi-Fi partagé)
- **Code de partie** : sans le code à 4 chiffres affiché sur ton écran, personne ne peut rejoindre. Un nouveau code est tiré à chaque lancement, et le bouton **🔄 Nouveau code** en génère un autre (les joueurs déjà connectés restent dans la partie). Après 5 codes faux en une minute, un appareil est bloqué pendant une minute.
- **🔓/🔒 Salon ouvert / fermé** : une fois tes potes connectés, ferme le salon. Plus personne de nouveau ne peut entrer, même avec le code. Les joueurs déjà dans la partie peuvent toujours se reconnecter.
- **Retirer un joueur** (✕ sur son nom) l'exclut : il ne peut plus revenir depuis cet appareil jusqu'à ce que tu cliques sur **Tout débannir** ou que tu relances Quinzo.
- 2 joueurs maximum par appareil, et un appareil qui envoie des messages en rafale est déconnecté.
- **L'écran hôte et l'éditeur sont en accès libre** : n'importe qui sur le réseau qui connaît l'adresse peut les ouvrir (le bouton **🖥️ Écran hôte** de la page joueurs y mène). Le code de partie protège l'entrée dans la partie, pas l'écran hôte. Sur un Wi-Fi partagé avec des inconnus, active la connexion par mot de passe (voir les options avancées).
- Personne ne peut accéder à tes autres fichiers.
- Ferme la fenêtre noire à la fin : le serveur s'arrête et plus rien n'est accessible.

## ⚙️ Options avancées
- Imposer un code fixe : `set PIN=2468` avant `node server.js` (4 à 8 chiffres).
- Changer de port : `set PORT=8080` puis `node server.js` (Windows), ou `PORT=8080 node server.js` (Mac/Linux).
- Ne pas ouvrir le navigateur au lancement : `NO_OPEN=1`.
- **Connexion obligatoire à l'écran hôte (facultatif)** : définis `ADMIN_PASSWORD` (et éventuellement `ADMIN_USER`, `admin` par défaut) avant de lancer, par exemple `set ADMIN_PASSWORD=MonMotDePasse123` sous Windows. Une page de connexion protège alors l'écran hôte et l'éditeur. On peut aussi fournir un hash avec `ADMIN_PASSWORD_HASH`, obtenu par `node server.js hash-password "mon mot de passe"`. Sur Kubernetes : `--set admin.enabled=true`.
- Jusqu'à 50 joueurs par défaut (`MAX_PLAYERS=80` pour en accepter plus).
