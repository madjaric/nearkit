# NearKit's OpenBao (DEPLOYMENT.md §11): the key-encryption key for wallet keys, in the
# transit engine. Reachable only from the signer, over an internal Docker network, with TLS.
ui = false

# Integrated storage memory-maps its files, which mlock would pin whole; the host runs
# without swap instead, so key material never reaches a disk (bootstrap.sh).
disable_mlock = true

storage "raft" {
  path    = "/openbao/data"
  node_id = "nearkit-kms-1"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_cert_file   = "/openbao/tls/openbao.crt"
  tls_key_file    = "/openbao/tls/openbao.key"
  tls_min_version = "tls12"
}

# Every request is logged, with secret values HMAC-ed. Declared here, not through the API, so a
# token can neither turn it off nor send it elsewhere.
audit "file" "nearkit" {
  description = "Every request to NearKit's key service (values HMAC-ed)."
  options {
    file_path = "/openbao/logs/audit.log"
  }
}

api_addr     = "https://openbao:8200"
cluster_addr = "https://openbao:8201"
log_level    = "info"
