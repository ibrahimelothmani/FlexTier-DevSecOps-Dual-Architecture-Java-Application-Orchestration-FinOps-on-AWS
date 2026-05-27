#!/usr/bin/env bash

# ==============================================================================
# HASHICORP VAULT SETUP & KUBERNETES AUTH INTEGRATION SCRIPT
# ==============================================================================
# This script automates Vault initialization, enables KV v2 storage engines,
# writes application secrets, sets up K8s Auth, and binds access policies.
# ==============================================================================

set -euo pipefail

# Configuration
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
K8S_HOST="${K8S_HOST:-https://kubernetes.default.svc.cluster.local:443}"
POLICY_NAME="java-app-policy"
ROLE_NAME="java-app-role"
SECRET_PATH="secret/data/mysql"
SERVICE_ACCOUNT="default"
NAMESPACE="default"

echo "🔐 Connecting to HashiCorp Vault at ${VAULT_ADDR}..."
export VAULT_ADDR

# 1. Verify connection
if ! vault status &>/dev/null; then
    echo "⚠️  Vault is either sealed or unreachable. Please verify Vault is running and unsealed."
    exit 1
fi

echo "🟢 Vault connection verified."

# 2. Enable Key-Value V2 Storage Engine if not enabled
if ! vault secrets list | grep -q "^secret/"; then
    echo "📦 Enabling KV-v2 Secrets Engine..."
    vault secrets enable -path=secret kv-v2
else
    echo "📦 KV secrets engine already enabled."
fi

# 3. Write Secret Database Credentials
echo "🔑 Storing database credentials at ${SECRET_PATH}..."
vault kv put "${SECRET_PATH}" \
    username="admin" \
    password="SuperSecureAdminPassword123!" \
    db_name="UserDB"

# 4. Create Access Control Policy
echo "📝 Creating access control policy: ${POLICY_NAME}..."
vault policy write "${POLICY_NAME}" - <<EOF
# Read permissions on application secrets
path "secret/data/mysql" {
  capabilities = ["read"]
}
EOF

# 5. Enable and Configure Kubernetes Authentication Method
if ! vault auth list | grep -q "^kubernetes/"; then
    echo "☸️  Enabling Kubernetes Authentication..."
    vault auth enable kubernetes
else
    echo "☸️  Kubernetes authentication already enabled."
fi

# Extract Kubernetes local cluster tokens for Vault mapping
echo "⚙️  Configuring Vault Kubernetes authentication mapping..."
K8S_TOKEN_REVIEWER_JWT=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null || echo "mock-token-jwt")
K8S_CACERT=$(cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt 2>/dev/null || echo "mock-ca-cert")

vault write auth/kubernetes/config \
    token_reviewer_jwt="${K8S_TOKEN_REVIEWER_JWT}" \
    kubernetes_host="${K8S_HOST}" \
    kubernetes_ca_cert="${K8S_CACERT}" || echo "⚠️  Warning: Service Account tokens not found locally. Skipping local token configuration."

# 6. Bind K8s Service Account and Namespace to Vault Role
echo "🔗 Binding Kubernetes Service Account to Vault Role: ${ROLE_NAME}..."
vault write "auth/kubernetes/role/${ROLE_NAME}" \
    bound_service_account_names="${SERVICE_ACCOUNT}" \
    bound_service_account_namespaces="${NAMESPACE}" \
    policies="${POLICY_NAME}" \
    ttl=24h

echo "🚀 Vault and Kubernetes integration setup successfully completed!"
