# export KUBECONFIG=~/.kube/config-k3s-oidc for auth in kubernetes cluster

# export KUBECONFIG=~/.kube/config-k3s for no auth

rm -rf ~/.kube/cache/oidc-login && echo "jeton OIDC supprimé"
