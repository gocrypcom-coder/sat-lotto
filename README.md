# ⚡ Sat-Lotto: Trustless Lightning Lottery

Sat-Lotto ist ein Open-Source-Projekt, das eine verifizierbare Lotterie auf Basis des Lightning Network und der Bitcoin Blockchain implementiert. Das Ziel ist maximale Transparenz und eine hervorragende Benutzererfahrung (UX) durch automatische Auszahlung.

## ✨ Kernfunktionen

* **Verifizierbarer Zufall:** Der Gewinner wird durch eine kryptografisch sichere Kombination aus dem **vom Betreiber commiteteten Seed** und dem **Hash eines zukünftigen Bitcoin-Blocks** bestimmt.
* **Transparenz (Commitment-Reveal):** Die Liste der Teilnehmer (als Merkle-Root) und der Betreiber-Seed-Hash werden vor der Ziehung über Nostr veröffentlicht.
* **Lightning UX:** Multi-Tier-Einsätze (100/1k/10k Sats), Multi-Entry-Tickets und **automatische Auszahlung** über LNURL-pay (Lightning Address).
* **Architektur:** Managed Lightning Node (Blockstream Greenlight) für geringen Hosting-Aufwand.

## 🏗️ Systemarchitektur

Die Anwendung verwendet eine schlanke Microservice-Architektur:

| Service | Technologie | Zweck |
| :--- | :--- | :--- |
| **Backend** | Node.js (Express), PostgreSQL | Kernlogik, API-Endpunkte, Scheduler für Ziehung. |
| **Zahlungen** | Blockstream Greenlight SDK | Non-Custodial Lightning Node für Invoices und Payouts. |
| **Blockchain Data** | Public Bitcoin Explorer API | Abruf der aktuellen Blockhöhe und des Block-Hash. |
| **Frontend** | HTML/Tailwind CSS | Mobile-first Interface. |
| **DB** | PostgreSQL | Speicherung von Runden, Tickets und Invoices. |
| **Infrastruktur** | Docker Compose | Orchestrierung aller Dienste. |

## 🚀 Installation & Start (Testnet-Empfehlung)

### 1. Vorbereitung der Umgebung

Stellen Sie sicher, dass **Docker** und **Docker Compose** auf Ihrem VPS installiert sind.

### 2. Konfiguration

Erstellen Sie die Datei `.env` im Hauptverzeichnis. Ersetzen Sie die Platzhalter:

```bash
# .env

# Greenlight und Netzwerk
BITCOIN_NETWORK=testnet 
GREENLIGHT_MNEMONIC="[IHR 12/24 WÖRTER GREENLIGHT SEED HIER]" 
NODE_ID="[IHR GREENLIGHT PUBKEY HIER]" 

# Datenbank
POSTGRES_USER=satlotto_user
POSTGRES_PASSWORD=SEHR_SICHERES_PASSWORT
POSTGRES_DB=satlotto_db
DATABASE_URL=postgres://satlotto_user:SEHR_SICHERES_PASSWORT@postgres:5432/satlotto_db

# Nostr
NOSTR_PUBKEY=dein_nostr_pubkey_hier_einfuegen
