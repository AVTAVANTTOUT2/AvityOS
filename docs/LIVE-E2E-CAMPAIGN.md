# Campagne live E2E — runbook opérateur

Ce document décrit comment préparer, vérifier et exécuter une **campagne live**
AvityOS avec de vrais providers, un dépôt Git externe et GitHub, **sans fusion
automatique** et **sans secrets dans le dépôt ou les arguments CLI**.

Dernier relevé de campagne :
[`LIVE-E2E-EVIDENCE-2026-07-23.md`](./LIVE-E2E-EVIDENCE-2026-07-23.md).

## Principes non négociables

| Règle | Signification |
| --- | --- |
| `ready` ≠ `passed` | Un scénario **runnable** n’a pas encore été tenté ni réussi. |
| `prepare` non mutant | Aucun push, PR, objectif ni appel provider payant. |
| `run` avec confirmation | L’objectif n’est soumis qu’après confirmation explicite du projet. |
| Pas de merge | Le runner de campagne n’expose aucune opération de fusion. |
| Pas de secrets en args | Tokens via `--token-stdin`, `--token-file` (0600) ou fichiers env. |
| `fake` interdit en prod | En `AVITY_EXECUTION_MODE=production`, le fixture n’est jamais enregistré. |

Pour une campagne live, le control plane doit tourner en
`AVITY_EXECUTION_MODE=campaign` (voir [Préparation](#préparation)).

---

## Préparation

### 1. Installation et build

```sh
pnpm install --frozen-lockfile
pnpm -r build
```

Prérequis hôte : Node **≥ 22.5**, pnpm 11, Git, GitHub CLI (`gh`), binaire
sandbox (`sandbox-exec` sur macOS, `bwrap` sur Linux).

### 2. Bootstrap opérateur local

Depuis la racine du dépôt AvityOS :

```sh
node apps/cli/dist/main.js init
node apps/cli/dist/main.js login --url http://127.0.0.1:7717 --token-file ~/.avity/api-token
node apps/cli/dist/main.js setup
```

`avity setup` crée l’état opérateur sous `~/.avity/operator/` (mode 0700),
construit control-plane / worker / web, détecte les outils manquants et **ne
remplace pas** un `operator.env` existant sans `--force`.

Alternative macOS durable : voir [deploy/launchd/README.md](../deploy/launchd/README.md)
et le générateur :

```sh
node deploy/launchd/install-user-services.mjs
```

### 3. Credentials hors dépôt

Ne jamais committer de secrets. Stocker les valeurs réelles dans :

| Emplacement | Usage |
| --- | --- |
| `~/.avity/operator/config/operator.env` | URL control plane, token API, worker (0600) |
| `~/.config/avityos/control-plane.env` | Variables et credentials providers du control plane (0600) |
| `~/.config/avityos/worker.env` | Variables propres au worker (0600) |
| Variables d’environnement du shell | Clés providers (`CODEX_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, …) |

`avity start` et `avity restart` chargent automatiquement le fichier protégé
propre au service lorsqu'il existe. Les credentials renouvelés conservés dans
`operator.env` (`AVITY_API_TOKEN`, `AVITY_WORKER_ID`,
`AVITY_WORKER_TOKEN`, URL du control plane) ont priorité sur une ancienne
valeur du fichier de service. Le Web ne reçoit jamais les variables du control
plane ou du worker. Un fichier de service lisible par le groupe ou les autres
utilisateurs bloque le démarrage.

Connexion CLI (refuse `--token` en clair) :

```sh
avity login --url http://127.0.0.1:7717 --token-stdin
# ou
avity login --url http://127.0.0.1:7717 --token-file /chemin/absolu/token
```

Pour une souscription Claude sans clé API, générer le jeton d’automatisation
officiel avec `claude setup-token`, puis le stocker comme
`CLAUDE_CODE_OAUTH_TOKEN` dans l’environnement protégé du control plane.

Pour une connexion Cursor par navigateur sans clé API, utiliser son store
portable owner-only, puis vérifier l’état dans le même mode :

```sh
AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login
AGENT_CLI_CREDENTIAL_STORE=file cursor-agent status
```

AvityOS ne monte jamais le Keychain ou le HOME complet : il copie uniquement
`~/.cursor/auth.json` en lecture seule dans le HOME jetable du run.

### 4. Mode campagne et chaîne de providers

Dans le fichier d’environnement du **control plane** (pas dans un plist) :

```text
AVITY_EXECUTION_MODE=campaign
AVITY_PROVIDER_CHAIN=codex,claude-code,cursor,openai,anthropic
AVITY_DEFAULT_MODELS=codex=...,claude-code=...,cursor=...,openai=...,anthropic=...
AVITY_REVIEW_MODELS=anthropic=...,openai=...
AVITY_ROLE_PROVIDERS=frontend=cursor|codex,backend=claude-code|codex,orchestrator=openai|anthropic,cybersecurity=codex|claude-code
```

- Seuls les adapters avec credentials valides sont enregistrés.
- Le provider `fake` est **rejeté** en mode `campaign` et `production`.
- Pour tester le fallback contrôlé : `AVITY_CAMPAIGN_FAULT_PROVIDER` +
  `AVITY_CAMPAIGN_FAULT_CATEGORY` **uniquement** en mode `campaign`, avec
  `--allow-fault-injection` sur `prepare`/`run`.

Détails adapters : [PROVIDER-ADAPTERS.md](./PROVIDER-ADAPTERS.md).

### 5. Modèles, rôles et reviewer

| Variable | Rôle |
| --- | --- |
| `AVITY_DEFAULT_MODELS` | Modèles d’exécution par provider |
| `AVITY_REVIEW_MODELS` | Modèles du reviewer (identité distincte) |
| `AVITY_ROLE_PROVIDERS` | Chaîne effective par rôle d’équipe (`\|` = fallback) |

Le scénario `reviewer_distinct_from_author` exige **deux providers réels**
distincts sur la chaîne reviewer effective. Le scénario
`cross_provider_fallback` exige au moins deux providers réels sur une chaîne
brain ou mission.

### 6. GitHub

```sh
gh auth login
gh auth status
git config --global user.name "…"
git config --global user.email "…"
```

Le preflight vérifie `git`, `gh`, authentification `gh`, lecture du dépôt et
**dry-run push** contre le remote **exact** configuré sur le projet (pas
forcément `origin`).

### 7. Fixture externe

Créer un dépôt cible **hors** du monorepo AvityOS :

```sh
avity e2e fixture create --path /chemin/absolu/live-e2e-fixture \
  --remote git@github.com:ORG/live-e2e-fixture.git
```

- Branche initiale : `main`.
- Aucun push automatique.
- Voir [live-fixture-spec.md](./live-fixture-spec.md).

### 8. Projet AvityOS

Démarrer les services :

```sh
avity start
# ou par service :
avity start --service control-plane
avity start --service worker
avity start --service web
```

Créer le projet lié à la fixture :

```sh
avity project create "Live E2E fixture" \
  --repo /chemin/absolu/live-e2e-fixture \
  --remote git@github.com:ORG/live-e2e-fixture.git \
  --branch main \
  --autonomy autonomous_with_checkpoints \
  --budget 100 --warn-at 80
```

Conserver l’identifiant public retourné (`prj_…`) pour les étapes suivantes.

---

## Vérification

Exécuter **dans l’ordre** avant toute campagne.

### 1. Doctor (hôte + services)

```sh
avity doctor
avity doctor --json
```

États possibles : `ready`, `blocked_operator_configuration`,
`blocked_missing_tool`, `blocked_missing_credentials`, `blocked_product_gap`.

Le doctor échoue (code ≠ 0) sur `blocked_missing_tool` et
`blocked_operator_configuration`.

### 2. Statut des services

```sh
avity status
avity status --json
```

Vérifier control-plane / web / worker `running`, projets actifs et
interventions ouvertes.

### 3. Statut providers (control plane)

```sh
avity provider status
avity provider list
```

Commande exacte : **`avity provider status`** (pas `providers`).

Expose binaires, sandbox, auth, modèles, rôles routés, reviewer distinct et
fallback — **sans** appeler les vendors.

### 4. Preflight projet

```sh
avity e2e preflight --project prj_XXXX
avity e2e preflight --project prj_XXXX --json
```

Évalue les dix scénarios mandatory. `ready` = tentable, **pas** réussi.

### 5. Lecture des blocages

```sh
avity project show prj_XXXX
avity brain show prj_XXXX
avity mission list prj_XXXX
avity intervention list
avity clarification list prj_XXXX --status open
```

### 6. Sandbox

Si `doctor` signale `sandbox` KO : corriger l’hôte (installer / activer
`sandbox-exec` ou `bwrap`). **Aucun** repli non sandboxé n’existe.

---

## Campagne

### 1. Démarrage des services

```sh
avity start
avity status
```

### 2. Objectif recommandé (campagnes `run`)

Le runner soumet automatiquement l’objectif fixture documenté dans
`apps/cli/src/operator/campaign.ts` (planification réelle, missions providers,
review indépendante, correction bornée, branche + PR **sans merge**).

Ne pas compter sur un objectif ad hoc pour la campagne certifiante ; utiliser
`e2e live run`.

### 3. Prepare (diagnostic seul)

```sh
avity e2e live prepare --project prj_XXXX
avity e2e live prepare --project prj_XXXX --json
```

- Appels **GET uniquement** côté API publique.
- Tous les scénarios restent `not_attempted` ou `blocked`.
- Rapport redigé sous `~/.avity/operator/reports/`.
- Succès si `readiness.status === ready`.

### 4. Clarifications

Si une clarification s’ouvre pendant `run` :

```sh
avity clarification show prj_XXXX
avity clarification answer prj_XXXX logicalKey=reponse
# ou interactif sur TTY
```

### 5. Missions par provider

Observer via :

```sh
avity mission list prj_XXXX
avity run list --project prj_XXXX
avity run logs run_XXXX
```

Scénarios attendus : `codex_mission`, `claude_code_mission`, `cursor_mission`
(selon chaînes configurées).

### 6. Fallback

Optionnel et **explicite** :

```sh
# env control plane :
# AVITY_CAMPAIGN_FAULT_PROVIDER=codex
# AVITY_CAMPAIGN_FAULT_CATEGORY=rate_limit

avity e2e live run --project prj_XXXX --allow-fault-injection ...
```

Sans `--allow-fault-injection`, une config fault active bloque la campagne.

### 7. Rejet / correction

La fixture documente une mission correction avec invariant
`FIX: INC-<digits> <summary>`. Preuves via checkpoints, events et
`intervention list`.

### 8. Review

Reviewer distinct de l’auteur quand la chaîne le permet. Vérifier les runs
de rôle `review` et le scénario `reviewer_distinct_from_author`.

### 9. Push et PR draft

La campagne s’arrête après preuve d’une PR **draft** ou **ready-for-review**
(`--pr-policy draft|ready-for-review`). **Jamais** de merge.

```sh
avity pr list --project prj_XXXX
avity pr show pr_XXXX
```

### 10. Run (exécution)

```sh
# TTY : saisie interactive du project id
avity e2e live run --project prj_XXXX

# Non interactif :
avity e2e live run --project prj_XXXX --confirm-project prj_XXXX

# Options :
avity e2e live run --project prj_XXXX --pr-policy draft \
  --max-polls 150 --poll-interval-ms 2000
```

### 11. Rapport

Chaque `prepare` / `run` écrit un rapport versionné (chemin affiché en sortie).
Conserver le fichier pour la traçabilité chantier-4.

---

## Dépannage

| Problème | Piste |
| --- | --- |
| Binaire absent | `doctor` / `provider status` ; installer `codex`, `claude`, `cursor-agent`, `node`, `pnpm`, `git`, `gh`. |
| Sandbox absent | `blocked_operator_configuration` ; activer `sandbox-exec` (macOS) ou `bwrap` (Linux). |
| Credential absent | `blocked_missing_credentials` ; renseigner clés env ou fichiers auth sandbox-portables (voir PROVIDER-ADAPTERS). |
| Credential non portable | Keychain / login interactif non monté dans le sandbox ; préférer `*_API_KEY` ou fichiers policy. |
| Modèle inconnu | Ajuster `AVITY_*_MODELS` pour un modèle listé par `provider status`. |
| Permission GitHub insuffisante | `gh auth status`, rôle `WRITE`+ sur le remote projet ; preflight `draft_pull_request`. |
| Worker offline | `avity status`, `avity worker list`, `avity logs --service worker` ; ré-enrollment si révoqué. |
| Dépôt sale | Nettoyer le worktree cible avant campagne ; AvityOS exige un arbre propre pour commit. |
| Branche / remote invalide | `avity project show` ; `project update` avec `--repo` / `--remote` absolus valides. |
| Timeout campagne | Augmenter `--max-polls` / `--poll-interval-ms` ; inspecter runs bloqués. |
| Quota provider | Attendre reset ou fallback ; events `provider.fallback`. |
| Crash provider | `run logs`, checkpoints failed ; intervention si correction épuisée. |
| Correction épuisée | `intervention list` ; décision opérateur ou correction manuelle fixture. |
| Reprise après restart | `avity start` ; control plane réconcilie ; relancer `prepare` puis `run` si état incohérent. |

Logs opérateur :

```sh
avity logs --service control-plane --max-bytes 65536
avity logs --service worker
avity logs --service web
```

---

## Matrice golden path

| État readiness | Signification opérateur | Action typique |
| --- | --- | --- |
| `ready` | Outils, sandbox, credentials et routing permettent **d’essayer** | `e2e live prepare`, puis `run` après confirmation |
| `blocked_operator_configuration` | Mode, sandbox, fault injection, routing incohérent | Corriger env (`AVITY_EXECUTION_MODE=campaign`, sandbox, chaînes) |
| `blocked_missing_tool` | `node`/`pnpm`/`git`/`gh`/binaire CLI manquant | Installer l’outil, `setup`, `doctor` |
| `blocked_missing_credentials` | Provider réel requis mais auth absente | Clés env ou fichiers auth, `login` |
| `blocked_product_gap` | Produit / API / scénario non satisfait côté plateforme | Escalade dev ; ne pas forcer `run` |

---

## Checklist finale (copiable)

```text
[ ] pnpm install --frozen-lockfile && pnpm -r build
[ ] avity init && avity login (--token-stdin|--token-file)
[ ] avity setup
[ ] AVITY_EXECUTION_MODE=campaign dans env control plane (pas de fake)
[ ] Providers réels + AVITY_*_MODELS + AVITY_ROLE_PROVIDERS + AVITY_REVIEW_MODELS
[ ] gh auth status OK ; remote GitHub du projet validé
[ ] avity start && avity status (control-plane + worker running)
[ ] avity doctor → readiness ready (ou blocages compris et corrigés)
[ ] avity provider status → adapters réels healthy
[ ] avity e2e fixture create --path … [--remote …]
[ ] avity project create … --repo … --remote … --branch main
[ ] avity e2e preflight --project <id> → scénarios ready (≠ passed)
[ ] avity e2e live prepare --project <id> → readiness ready, rapport archivé
[ ] avity e2e live run --project <id> [--confirm-project <id>]
[ ] PR draft/ready-for-review observée ; aucune fusion
[ ] Rapport campagne conservé sous ~/.avity/operator/reports/
```

---

## Références

- [PROVIDER-ADAPTERS.md](./PROVIDER-ADAPTERS.md) — auth sandbox, preflight, fake
- [LOCAL-DEVELOPMENT.md](./LOCAL-DEVELOPMENT.md) — dev local et verify
- [RUNBOOKS.md](./RUNBOOKS.md) — incidents courants
- [deploy/launchd/README.md](../deploy/launchd/README.md) — services macOS
- [live-fixture-spec.md](./live-fixture-spec.md) — contenu fixture
