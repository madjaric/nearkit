#!/usr/bin/env bash
# Checks the FORM of an OpenBao unseal key, without printing, storing or sending it: its length,
# character set and any stray whitespace. Nothing leaves this machine and no OpenBao is contacted.
#
#   bash deploy/vps/unseal-key-check.sh            the key is read hidden from the terminal
#   bash deploy/vps/unseal-key-check.sh --stdin    read from standard input (tests with made-up keys only)
#
# OpenBao accepts the key as openbao-init showed it: standard Base64 of 32 bytes (44 characters, the
# last one "="), or the same 32 bytes as 64 hex characters. Trailing whitespace is tolerated by the
# unseal scripts; leading whitespace, a missing "=", URL-safe Base64 (- and _) or any other character
# is refused by OpenBao with "'key' must be a valid hex or base64 string".
set -uo pipefail
set +x
export LC_ALL=C
if [ "${1:-}" = --stdin ]; then
  IFS= read -r k || [ -n "${k:-}" ]
else
  exec 3< /dev/tty || { echo "Run this in a terminal." >&2; exit 2; }
  printf 'Unseal key (hidden, not stored, not sent): ' > /dev/tty
  IFS= read -rs k <&3
  exec 3<&-
  printf '\n' > /dev/tty
fi

# tr reads the octal escapes itself (a bare CR in an argument doesn't survive Git Bash on Windows).
count() { printf '%s' "$1" | tr -cd "$2" | wc -c | tr -d ' '; }
lead=${k%%[![:space:]]*}
rest=${k#"$lead"}
core=${rest%"${rest##*[![:space:]]}"}
trail=${rest#"$core"}
cr=$(count "$k" '\015')
inner=$(count "$core" ' ')
tabs=$(count "$k" '\011')
nonascii=$(printf '%s' "$k" | tr -d '\000-\177' | wc -c | tr -d ' ')

echo "length: ${#k} character(s) as entered, ${#core} without leading/trailing whitespace"
echo "leading whitespace: ${#lead} · trailing whitespace: ${#trail} · carriage returns: $cr · tabs: $tabs · spaces inside: $inner · non-ASCII bytes: $nonascii"

problems=()
[ "${#lead}" -gt 0 ] && problems+=("it starts with whitespace: OpenBao refuses that")
[ "$inner" -gt 0 ] && problems+=("it has spaces inside: an unseal key has none")
[ "$nonascii" -gt 0 ] && problems+=("it has non-ASCII characters (a letter from another keyboard layout, a typographic character from a notes app?)")
if [[ "$core" =~ ^[0-9a-fA-F]{64}$ ]]; then
  form="hex: 64 characters = 32 bytes, accepted by OpenBao"
elif [[ "$core" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  bytes=$(printf '%s' "$core" | base64 -d 2> /dev/null | wc -c | tr -d ' ')
  [ "$bytes" = 32 ] && form="Base64: 44 characters ending in '=', decodes to 32 bytes, the form openbao-init showed" ||
    { form="Base64-looking, but decodes to ${bytes:-0} bytes"; problems+=("it does not decode to the 32 bytes an unseal key has"); }
else
  form="neither form"
  [[ "$core" =~ [-_] ]] && problems+=("it has '-' or '_': URL-safe Base64; OpenBao's key uses '+' and '/'")
  [[ "$core" =~ ^[A-Za-z0-9+/]{43}$ ]] && problems+=("it is 43 Base64 characters: the final '=' is missing")
  [[ "$core" =~ =.+$ ]] && problems+=("it has '=' before the end: only the last character may be '='")
  [ "${#core}" -ne 44 ] && [ "${#core}" -ne 64 ] && problems+=("its length is ${#core}: Base64 has 44 characters, hex 64")
  stray=$(printf '%s' "$core" | tr -d 'A-Za-z0-9+/=' | wc -c | tr -d ' ')
  [ "$stray" -gt 0 ] && problems+=("$stray character(s) outside Base64's alphabet (A-Z a-z 0-9 + / =)")
fi
echo "form: $form"
unset k core rest lead trail
if [ "${#problems[@]}" -eq 0 ]; then
  echo "verdict: well-formed. OpenBao will accept its form; only an unseal decides whether it is the right key."
  exit 0
fi
for p in "${problems[@]}"; do echo "problem: $p"; done
echo "verdict: OpenBao would refuse this with \"'key' must be a valid hex or base64 string\"."
exit 1
