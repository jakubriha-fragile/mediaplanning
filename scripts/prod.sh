#!/bin/sh
# Spustí příkaz proti PRODUKČNÍ databázi.
#
# Connection string je v Klíčence macOS (šifrovaně, mimo projekt), takže se
# nemusí pokaždé vkládat a nikdy se nedostane do gitu ani do historie terminálu.
# Uložení (jednou, nepoolovaný string z Neonu):  npm run prod:ulozit
set -e
URL=$(security find-generic-password -s mediaplanning-neon-prod -w 2>/dev/null) || {
  echo "V Klíčence chybí connection string produkční databáze."
  echo "Uložte ho jednou příkazem:  npm run prod:ulozit"
  exit 1
}
echo "→ produkční databáze"
DATABASE_URL="$URL" exec "$@"
