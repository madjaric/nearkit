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

api_addr     = "https://openbao:8200"
cluster_addr = "https://openbao:8201"
log_level    = "info"
