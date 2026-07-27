# Mode d’emploi AvityOS — de A à Z

> Guide complet pour une personne non initiée.  
> Objectif : comprendre **ce qu’est** AvityOS, **comment l’installer**, **comment l’utiliser au quotidien**, et **où chercher** en cas de problème.

Version du produit documentée : **0.1.0**  
Dernière mise à jour du guide : **2026-07-25**

---

## Table des matières

1. [En une phrase](#1-en-une-phrase)
2. [Vocabulaire (à lire une fois)](#2-vocabulaire-à-lire-une-fois)
3. [Ce que fait AvityOS — et ce qu’il ne fait pas](#3-ce-que-fait-avityos--et-ce-quil-ne-fait-pas)
4. [Les trois façons d’utiliser AvityOS](#4-les-trois-façons-dutiliser-avityos)
5. [Prérequis](#5-prérequis)
6. [Installation pas à pas](#6-installation-pas-à-pas)
7. [Premier démarrage (parcours guidé)](#7-premier-démarrage-parcours-guidé)
8. [Créer un projet et lancer un objectif](#8-créer-un-projet-et-lancer-un-objectif)
9. [Le cycle de vie d’un projet (A → Z)](#9-le-cycle-de-vie-dun-projet-a--z)
10. [L’interface web Mission Control](#10-linterface-web-mission-control)
11. [La CLI `avity` (référence pratique)](#11-la-cli-avity-référence-pratique)
12. [L’application macOS](#12-lapplication-macos)
13. [Providers IA (Codex, Claude, Cursor, etc.)](#13-providers-ia-codex-claude-cursor-etc)
14. [Profils d’autonomie, budgets et interventions](#14-profils-dautonomie-budgets-et-interventions)
15. [Workers (exécuter sur une autre machine)](#15-workers-exécuter-sur-une-autre-machine)
16. [Sécurité, secrets et vault](#16-sécurité-secrets-et-vault)
17. [Sauvegarde et restauration](#17-sauvegarde-et-restauration)
18. [Déploiement (une machine « serveur »)](#18-déploiement-une-machine-serveur)
19. [Vérifier que tout fonctionne](#19-vérifier-que-tout-fonctionne)
20. [Dépannage (symptômes → actions)](#20-dépannage-symptômes--actions)
21. [FAQ](#21-faq)
22. [Où aller plus loin](#22-où-aller-plus-loin)

---

## 1. En une phrase

**AvityOS** est un système local qui prend un **objectif logiciel** (« construire X avec tels critères »), le découpe en missions spécialisées, les fait exécuter par des agents IA (ou un provider de test), **vérifie** le résultat (tests, builds, revue), puis prépare un **livrable Git** (commits, pull request en brouillon) — sans que vous ayez à micro-manager dix outils différents.

Vous donnez le **quoi**. AvityOS orchestre le **comment**, et ne vous interrompt que lorsqu’une **vraie décision** humaine est nécessaire.

---

## 2. Vocabulaire (à lire une fois)

| Terme | Signification simple |
| --- | --- |
| **Control plane** | Le « cerveau central » d’AvityOS : API locale, orchestration, base SQLite. Sans lui, rien ne tourne. |
| **Projet** | Un dépôt / un produit isolé. Chaque projet a sa mémoire, son budget, ses missions. |
| **Objectif** | Ce que vous voulez obtenir, en langage naturel, avec des critères d’acceptation optionnels. |
| **Clarification** | Ensemble groupé de questions qu’AvityOS pose **une seule fois** si quelque chose d’important est ambigu. |
| **Brain (cerveau de projet)** | Mémoire durable du projet : décisions, plans, résultats, risques — pas un chat caché. |
| **Plan / DAG** | Plan versionné + graphe de dépendances entre missions. |
| **Mission** | Unité de travail spécialisée (frontend, backend, QA, revue, etc.) avec contrat strict. |
| **Run** | Une tentative d’exécution d’une mission (peut être relancée après échec). |
| **Provider** | Adaptateur vers une IA ou un outil (OpenAI, Anthropic, Codex, Claude Code, Cursor, fake…). |
| **Fake / fixture** | Provider de test déterministe. Sert à vérifier l’orchestration **sans** payer d’API. Jamais une « vraie » preuve de livraison produit. |
| **Intervention** | Demande d’approbation ou de réponse humaine (clarification, budget, action dangereuse…). |
| **Worktree** | Copie de travail Git isolée pour une mission (branche dédiée). |
| **Checkpoint** | Preuve objective qu’un contrôle a réussi (test, build, lint, scan…). |
| **Worker** | Processus (local ou distant) qui exécute les commandes / terminaux sous bail authentifié. |
| **Vault** | Coffre chiffré pour les secrets opérateur (clés API, tokens). |
| **SSE** | Flux temps réel vers l’interface web (état Live / Hors ligne). |
| **Autonomy profile** | Niveau d’autonomie autorisé pour un projet (`supervised`, `autonomous_with_checkpoints`, `maximum_autonomy`). |

---

## 3. Ce que fait AvityOS — et ce qu’il ne fait pas

### Il fait

- Centraliser plusieurs projets isolés.
- Analyser un objectif, clarifier si besoin, planifier, déléguer, exécuter, valider.
- Isoler le travail (branches, worktrees, processus, budgets).
- Exiger des **preuves** avant de déclarer une mission terminée.
- Préparer des commits et des **PR draft** GitHub.
- Garder une piste d’audit durable (événements + chaîne de hachage).
- Tourner en **local-first** : une installation pnpm + une base SQLite suffisent pour le cycle complet avec le provider fake.

### Il ne fait **pas** (par conception)

- Fusionner tout seul une branche protégée ou une PR.
- Acheter de l’infra cloud / déployer en production sans approbation.
- Élargir discrètement l’accès aux secrets.
- Présenter le mode démo / fake comme une livraison réelle.
- Remplacer votre jugement sur les décisions dangereuses ou irréversibles.

---

## 4. Les trois façons d’utiliser AvityOS

```text
   Interface web          App macOS              CLI `avity`
   (Mission Control)      (SwiftUI)              (scripts / headless)
            \                 |                      /
             +-------- REST + SSE (control plane) ---+
                              |
                     Base SQLite locale
```

| Surface | Pour qui | Adresse / commande typique |
| --- | --- | --- |
| **Web** | Usage quotidien, suivi visuel | `http://localhost:5173` (dev) |
| **macOS** | Usage natif, notifications, menu bar | `swift run AvityOS` ou le `.app` |
| **CLI** | Automatisation, ops, diagnostics | `avity …` ou `node apps/cli/dist/main.js …` |

Les trois parlent au **même** control plane. Ce que vous créez en CLI apparaît dans le web, et inversement.

---

## 5. Prérequis

### Obligatoires (stack TypeScript)

| Outil | Version | Pourquoi |
| --- | --- | --- |
| **Node.js** | ≥ **22.5** | SQLite intégré (`node:sqlite`) |
| **pnpm** | **11** (piné `11.11.0`) | Monorepo |
| **Git** | récent | Worktrees, commits, remotes |

Activer pnpm via Corepack si besoin :

```sh
corepack enable
```

### Selon votre OS

| Plateforme | Notes |
| --- | --- |
| **macOS 14+** | Stack complète + app SwiftUI. Xcode 15+ pour builder/tester l’app. Sandbox : `sandbox-exec`. |
| **Linux** | Control plane, worker, web, CLI. Pour les checks sandboxés : installer **Bubblewrap** (`bwrap`). Sans Bubblewrap, le sandbox échoue en mode fermé (`sandbox_unavailable`). |

### Optionnels

- Clés / CLIs des providers (Codex, Claude Code, Cursor, OpenAI, Anthropic, DeepSeek) pour de **vraies** exécutions IA.
- `gh` (GitHub CLI) authentifié pour pousser et ouvrir des PR draft.
- `sqlite3` pour certaines opérations de backup documentées.
- `gitleaks` pour scan de secrets en local.

---

## 6. Installation pas à pas

### 6.1 Cloner et installer

```sh
git clone https://github.com/AVTAVANTTOUT2/AvityOS.git
cd AvityOS
pnpm install --frozen-lockfile
```

`--frozen-lockfile` aligne votre install sur la CI. Ne modifiez pas le lockfile « pour voir ».

### 6.2 Variables d’environnement

Le fichier [`.env.example`](../.env.example) liste **les noms** des variables (jamais de secrets).

Pour démarrer en local, les défauts suffisent souvent :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `AVITY_HOST` / `AVITY_PORT` | `127.0.0.1` / `7717` | Adresse du control plane |
| `AVITY_DB_PATH` | `~/.avity/avity.sqlite` | Base de données |
| `AVITY_API_TOKEN` | auto-généré dans `~/.avity/api-token` | Authentification API |
| `VITE_AVITY_API` | `http://127.0.0.1:7717` | URL vue par le web |
| `VITE_AVITY_DEMO` | (off) | Mettre `1` **uniquement** pour forcer des fixtures démo |

**Ne committez jamais** un fichier `.env` contenant des secrets.

### 6.3 Construire (recommandé avant le premier `start`)

```sh
pnpm build
# ou au minimum :
pnpm --filter @avityos/control-plane build
pnpm --filter @avityos/cli build
pnpm --filter @avityos/worker build
```

Le script `start` du control plane exécute `node dist/main.js` : sans `dist/`, ça échoue.

---

## 7. Premier démarrage (parcours guidé)

Ouvrez **plusieurs terminaux** à la racine du dépôt.

### Étape A — Control plane

```sh
pnpm --filter @avityos/control-plane start
```

Attendu : API sur **http://127.0.0.1:7717**.

Au premier lancement, un jeton bearer est généré (fichier mode `0600`, souvent `~/.avity/api-token`) si vous n’avez pas fourni `AVITY_API_TOKEN`.

### Étape B — Interface web

```sh
pnpm --filter @avityos/web dev
# équivalent : pnpm dev
```

Ouvrez **http://localhost:5173**.

Regardez le badge de connexion :

| Badge | Signification |
| --- | --- |
| **Live** / « Système opérationnel » | Connecté au control plane |
| **Hors ligne** | Control plane injoignable |
| **Reconnexion** / « Connexion… » | Tentative de reprise SSE |
| **Démo** | Fixtures web actives (`VITE_AVITY_DEMO=1`) — **pas** de données réelles |

### Étape C — (Optionnel) Worker

```sh
pnpm --filter @avityos/worker start
```

Utile pour exécuter les checks / terminaux via un worker dédié.

### Étape D — Bootstrap opérateur (recommandé)

```sh
pnpm --filter @avityos/cli build
node apps/cli/dist/main.js setup
node apps/cli/dist/main.js doctor
```

- `setup` : initialise l’environnement opérateur local sécurisé.
- `doctor` : diagnostique l’hôte (outils, sandbox, readiness).

Si vous avez installé un binaire `avity` dans le PATH, vous pouvez remplacer `node apps/cli/dist/main.js` par `avity`.

### Étape E — (Optionnel) App macOS

```sh
cd apps/macos && swift run AvityOS
```

Le control plane doit déjà tourner.

### Checklist « je suis prêt »

- [ ] `pnpm install --frozen-lockfile` OK  
- [ ] Control plane écoute sur `:7717`  
- [ ] Web affiche **Live**  
- [ ] `avity doctor` (ou équivalent) ne bloque pas sur l’essentiel  
- [ ] (Optionnel) Worker démarré  

---

## 8. Créer un projet et lancer un objectif

### 8.1 Via la CLI (recommandé pour comprendre)

```sh
# Projet greenfield (sans dépôt existant)
node apps/cli/dist/main.js project create "Mon premier projet" \
  --objective "Ajouter une page d’accueil claire et testée" \
  --criterion "Les tests unitaires passent" \
  --criterion "La documentation est à jour" \
  --autonomy autonomous_with_checkpoints \
  --budget 100 --warn-at 80
```

Projet lié à un dépôt Git **déjà présent sur la machine du control plane** :

```sh
node apps/cli/dist/main.js project create "Repo existant" \
  --repo /chemin/absolu/vers/le/depot \
  --remote git@github.com:org/repo.git \
  --branch main \
  --objective "Corriger le bug X et ajouter des tests" \
  --criterion "pnpm test passe" \
  --autonomy supervised
```

Points importants :

1. Les chemins de dépôt **ne sont pas « crus » depuis le client** : le control plane les résout sur **son** hôte, vérifie que c’est un working tree Git accessible, que la branche locale existe, et que le remote GitHub demandé correspond bien à un remote configuré.
2. Les soumissions d’objectifs sont **idempotentes** (pas de doublons accidentels).
3. Vous pouvez aussi soumettre / réviser un objectif plus tard :

```sh
node apps/cli/dist/main.js objective submit <project-id> \
  "Nouvel objectif plus précis" \
  "Critère A" "Critère B"
```

### 8.2 Via le web

1. Ouvrez Mission Control → **Projets**.
2. Créez un projet (modal « New project » / équivalent UI).
3. Renseignez nom, objectif, critères, profil d’autonomie, budget.
4. Suivez l’état : clarifications → plan → missions → interventions.

### 8.3 Sans provider payant (mode apprentissage / vérif orchestration)

Sans clés API, le provider **fake** permet d’exercer le cycle (worktrees, checks, correction, review) de façon déterministe.  
C’est parfait pour apprendre AvityOS. Ce n’est **pas** une preuve que votre produit réel a été implémenté.

---

## 9. Le cycle de vie d’un projet (A → Z)

Voici le parcours complet, dans l’ordre. Toutes les étapes sont **durables** et **reprises après redémarrage**.

```text
Créer projet
    → Soumettre objectif (+ critères)
    → Analyse (snapshot dépôt sans secrets)
    → Clarification groupée SI ambiguïté matérielle
    → Vous répondez une fois → reprise automatique
    → Pipeline brain : analyse → architecture → plan/DAG
    → Validation déterministe du plan
    → Ordonnancement des missions (dépendances)
    → Exécution (provider / worker / sandbox)
    → Validation (fichiers, artifacts, commandes réelles)
    → Correction bornée si échec
    → Commit + PR draft (si GitHub)
    → Revue indépendante
    → Rapport / livrable — ou intervention si plus de chemin sûr
```

### Étape par étape

#### 1) Création du projet

Vous choisissez le profil d’autonomie et éventuellement le dépôt. Le projet est isolé : données, politiques, worktrees, budgets, logs.

#### 2) Objectif

Texte libre + critères d’acceptation. Une révision d’objectif peut rendre obsolète un groupe de clarification encore ouvert (même transaction).

#### 3) Clarification (seulement si besoin)

AvityOS **n’interroge pas goutte à goutte**. Une seule série groupée de questions, filtrée (pas de secrets demandés, pas de commandes shell arbitraires, pas de hors-sujet).  
Vous répondez ; le pipeline reprend **exactement une fois** (même après crash — mécanisme P-RESUME).

```sh
# Voir les questions
node apps/cli/dist/main.js clarification show <project-id>

# Répondre (interactif ou clés = valeurs)
node apps/cli/dist/main.js clarification answer <project-id> \
  choix_ui=minimal \
  auth=session_cookie
```

#### 4) Planification (brain)

Le control plane :

1. prend un **snapshot** borné et sans secrets du dépôt ;
2. fait analyser / proposer une architecture / un plan via un provider de raisonnement ;
3. **valide** le plan (dépendances acycliques, couverture des critères, rôles valides, chemins conformes, vraies commandes de check, budgets/timeouts) ;
4. persiste une **nouvelle version** de plan + missions.

Si la sortie du modèle est invalide : réparation bornée, puis blocage avec intervention — **jamais** de plan heuristique silencieux.

#### 5) Ordonnancement

Les missions dont les dépendances sont satisfaites passent à `ready`, puis démarrent selon les limites de concurrence globales et par projet.  
Un projet **en pause** ne démarre aucune nouvelle exécution.

#### 6) Exécution

Chaque run passe par un **adapter provider** versionné. Les secrets sont rédigés avant persistance. Les échecs suivent une politique explicite : attendre un reset de quota → retry → changer de modèle → changer de provider → escalader — **jamais** un basculement silencieux qui viole privacy / budget / capacités.

#### 7) Pause / reprise atomiques

```sh
node apps/cli/dist/main.js project pause <project-id> --reason "revue humaine"
node apps/cli/dist/main.js project resume <project-id>
```

Pause = transaction durable : statut `paused`, annulation des runs actifs, révocation des bails **du projet**, audit.  
Les résultats tardifs d’avant la pause sont **refusés** (fencing). La pause ne « gèle » pas la mémoire d’un provider externe ; elle garantit qu’aucun travail tardif ne s’intègre.

#### 8) Validation & correction

Des commandes réelles s’exécutent (worker ou sandbox OS fail-closed). Succès → checkpoints. Échec → **boucle de correction bornée**, puis intervention humaine — jamais de boucle infinie.

#### 9) Git & revue

- Branche / worktree isolés par mission (`mission/<id>-<slug>`).
- Commit après checks (sans hooks non fiables).
- Sur GitHub : push + **PR draft** idempotente.
- Revue par une identité / modèle distincts.
- **Pas de self-merge.** Un opérateur peut marquer une PR ready **hors** du moteur autonome.

#### 10) Fin

Le projet se termine quand toutes les missions sont dans un état terminal. Vous obtenez un rapport aligné sur les critères d’acceptation, ou une intervention s’il n’existe plus de chemin autonome sûr.

---

## 10. L’interface web Mission Control

Barre latérale (écrans principaux) :

| Écran | À quoi ça sert |
| --- | --- |
| **Vue générale** | Tableau de bord global |
| **Projets** | Liste / détail des projets, création |
| **Interventions** | Questions & approbations en attente (badge compteur) |
| **Agents** | Agents / rôles en jeu |
| **Exécutions** | Runs, terminaux, logs live |
| **GitHub & Code** | État Git / PR |
| **Providers** | Providers configurés / statut |
| **Activité** | Journal d’activité |
| **Paramètres** | Réglages |

### Habitudes utiles

1. Vérifier d’abord le **badge Live**.
2. Traiter les **Interventions** avant de « relancer » au hasard.
3. Dans un projet : suivre plan → missions (kanban) → runs → PR.
4. Ne jamais confondre **Démo** avec une campagne réelle.

### Mode démo

```sh
VITE_AVITY_DEMO=1 pnpm --filter @avityos/web dev
```

Le badge **Démo** doit rester visible. Les fixtures ne doivent pas être présentées comme une exécution live.

---

## 11. La CLI `avity` (référence pratique)

Aide intégrée :

```sh
node apps/cli/dist/main.js help
# ou
avity help
```

Ajoutez `--json` n’importe où pour une sortie machine-readable (scripts).

### Codes de sortie

| Code | Signification |
| --- | --- |
| `0` | Succès |
| `1` | Erreur API / runtime |
| `2` | Erreur d’usage (arguments) |

### Commandes essentielles (quotidien)

```sh
# Santé
avity doctor
avity status
avity logs --service control-plane

# Projets
avity project list
avity project show <id>
avity project create "Nom" --objective "…" --criterion "…"
avity project update <id> --budget 150 --warn-at 70
avity project pause <id> --reason "…"
avity project resume <id>

# Objectif & clarifications
avity objective submit <id> "texte" "critère1"
avity clarification list <id>
avity clarification show <id>
avity clarification answer <id> cle=valeur

# Plan / brain / missions / runs
avity plan show <id>
avity brain show <id>
avity mission list <id>
avity run list --project <id>
avity run logs <run-id>

# Interventions
avity intervention list
avity intervention answer <id> --decision approved

# Providers & workers
avity provider status
avity worker list
avity worker enroll mon-worker
avity worker revoke <worker-id>

# PR
avity pr list --project <id>
avity pr show <pr-id>
```

### Opérations (setup, vault, backup, services)

```sh
avity setup
avity login --url http://127.0.0.1:7717 --token-stdin

avity start [--service control-plane|worker|…]
avity stop
avity restart --service control-plane

# Secrets (jamais en argument CLI — uniquement stdin non-TTY)
printf '%s' "$OPENAI_API_KEY" | avity vault set OPENAI_API_KEY --stdin
avity vault list
avity vault status

avity backup create --database "$HOME/.avity/avity.sqlite" \
  --output /backups/avity/checkpoint-YYYY-MM-DD \
  --recovery /offline/avity-recovery/vault.recovery.json \
  --passphrase-stdin
```

### Campagne live E2E (avancé)

Réservé aux opérateurs qui valident des providers réels. Voir [LIVE-E2E-CAMPAIGN.md](./LIVE-E2E-CAMPAIGN.md).

Rappels critiques :

- `ready` = *exécutable*, **pas** *réussi* ;
- `prepare` ne mute pas le remote ;
- `run` exige une confirmation explicite du project id ;
- le provider `fake` est interdit comme preuve de campagne live.

---

## 12. L’application macOS

### Développement

```sh
cd apps/macos
swift build
swift test
swift run AvityOS
```

### Packaging local

```sh
./scripts/build-macos-app.sh
./scripts/install-macos-app.sh
```

### Ce que l’app apporte

- Authentification Keychain.
- État REST + SSE avec reconnexion.
- Vues projets / missions / runs / terminaux.
- Approbation d’interventions, deep links, notifications, badge Dock.
- Companion menu bar.

### Distribution publique

La release publique doit être **Developer ID signée + notarisée**, avec manifeste de mise à jour signé Ed25519 en HTTPS.  
Les artefacts « ad hoc » de CI ne sont **pas** une release publique. Voir [DEPLOYMENT.md](./DEPLOYMENT.md) et les runbooks associés.

---

## 13. Providers IA (Codex, Claude, Cursor, etc.)

Tous les appels IA passent par des **adapters** versionnés (`packages/providers`).  
Seuls les providers **avec credentials** sont enregistrés.

### Tableau rapide

| Provider | Type | Modifie le dépôt ? | Auth typique |
| --- | --- | --- | --- |
| `codex` | CLI `codex exec` | oui | `CODEX_API_KEY` ou `~/.codex/auth.json` |
| `claude-code` | CLI `claude -p` | oui | `ANTHROPIC_API_KEY` / token OAuth / credentials file |
| `cursor` | CLI `cursor-agent` | oui | `CURSOR_API_KEY` ou store fichier `~/.cursor/auth.json` |
| `openai` | API Responses | non (texte / revue) | `OPENAI_API_KEY` |
| `anthropic` | API Messages | non | `ANTHROPIC_API_KEY` |
| `deepseek` | API compatible OpenAI | non | `DEEPSEEK_API_KEY` |
| `command` | argv configurable | opt-in | allowlist env |
| `fake` | fixture déterministe | fixtures de test | aucune |

### Variables utiles (voir aussi `.env.example`)

```text
AVITY_PROVIDER_CHAIN=openai,anthropic,fake
AVITY_DEFAULT_MODELS=openai=gpt-4o,anthropic=claude-sonnet-4-5,fake=fake:code
AVITY_REVIEW_MODELS=anthropic=claude-opus-4-8
AVITY_ROLE_PROVIDERS=frontend=cursor|codex,backend=claude-code|codex
```

### Stocker une clé correctement

```sh
read -r -s AVITY_SECRET
printf '%s' "$AVITY_SECRET" | avity vault set OPENAI_API_KEY --stdin
unset AVITY_SECRET
avity restart --service control-plane
avity doctor
avity provider status
```

Ne mettez **jamais** un secret dans l’historique shell, dans un argument argv, ou dans un commit.

### Sandbox

Les CLIs d’édition tournent dans un sandbox OS **fail-closed** :

- écritures limitées au worktree (+ HOME jetable) ;
- lectures refusées par défaut hors allowlist ;
- réseau refusé sauf si le provider le déclare ;
- credentials minimaux stagés, pas le vrai HOME entier.

Sur Linux : installez Bubblewrap. Sur macOS : `sandbox-exec`.

Détails : [PROVIDER-ADAPTERS.md](./PROVIDER-ADAPTERS.md).

---

## 14. Profils d’autonomie, budgets et interventions

### Profils

| Profil | Comportement par défaut |
| --- | --- |
| `supervised` | Les actions ordinaires non matchées demandent une approbation. |
| `autonomous_with_checkpoints` | Autonomie avec checkpoints / preuves. |
| `maximum_autonomy` | Maximum d’autonomie **toujours borné** par les politiques. |

Même en `maximum_autonomy`, les actions dangereuses par construction restent en **require_approval** par défaut, par exemple :

- `git.push_force`
- `git.merge_protected`
- `deploy.production`
- `infra.provision_paid`
- `secret.read`
- `policy.override`
- `fs.delete_outside_worktree`
- `worker.revoke`

### Budgets

À la création / mise à jour du projet :

- `--budget <usd>` : plafond ;
- `--warn-at <percent>` : seuil d’alerte.

Dépasser le plafond **bloque** la mission et ouvre une intervention. La consommation est suivie transactionnellement.

### Interventions — quand vous êtes sollicité

Typiquement :

- clarification groupée ;
- budget épuisé ;
- boucle de correction épuisée ;
- action dangereuse / hors politique ;
- plan invalide après réparation bornée ;
- échec d’auth provider sans fallback autorisé.

Via web : écran **Interventions**.  
Via CLI :

```sh
avity intervention list
avity intervention answer <id> --decision approved
# ou pour une clarification :
avity intervention answer <id> cle=valeur
```

---

## 15. Workers (exécuter sur une autre machine)

Le control plane peut déléguer l’exécution à des workers authentifiés, avec baux courts et révocables.

### Enrôlement

```sh
avity worker enroll mon-laptop
# → affiche une fois worker id + token : stockez-les dans un secret store
```

### Lancement worker

```sh
export AVITY_CONTROL_PLANE_URL=https://plane.example   # https hors loopback
export AVITY_WORKER_ID=…
export AVITY_WORKER_TOKEN=…
# si mTLS :
export AVITY_TLS_CA_PATH=…
export AVITY_TLS_CLIENT_CERT_PATH=…
export AVITY_TLS_CLIENT_KEY_PATH=…

pnpm --filter @avityos/worker start
# ou : node services/worker/dist/main.js
```

### Révocation (machine perdue)

```sh
avity worker revoke <id>
```

Le token révoqué est refusé au prochain appel.  
Avec mTLS activé, l’enrôlement est lié à l’empreinte du certificat client.

Voir [DEPLOYMENT.md](./DEPLOYMENT.md) et [SECURITY.md](./SECURITY.md).

---

## 16. Sécurité, secrets et vault

### Modèle de confiance (résumé)

Tout ce qui vient des modèles, du dépôt, des terminaux ou du web est **non fiable**.  
Seul le control plane décide des transitions d’état, chemins, commandes, budgets et audit.

### Vault opérateur

- Chiffrement AES-256-GCM.
- macOS : clé maître Keychain par défaut.
- Linux : fichier clé **owner-only** **hors** dépôt et hors `~/.avity/operator` (`AVITY_VAULT_KEY_FILE` ou `--key-file`).

```sh
# macOS
avity vault migrate
avity vault status

# Linux
install -d -m 0700 /secure/avityos
avity vault migrate --key-file /secure/avityos/operator-vault.key
```

### Règles d’or

1. Secrets **uniquement** via stdin non-TTY (`--stdin` / `--passphrase-stdin`).
2. Jamais de secret dans git, tickets, captures d’écran, logs.
3. HTTP clair **uniquement** en loopback ; hors loopback → TLS 1.3.
4. Clés privées TLS en mode `0600`, dossiers `0700`.
5. Ne pas présenter fake/démo comme preuve live.

### Escrow de récupération de la clé maître

```sh
install -d -m 0700 /offline/avity-recovery
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity vault recovery-export \
    --output /offline/avity-recovery/vault.recovery.json \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
```

Conservez la passphrase **séparément** du fichier recovery.  
Ne mettez **pas** le recovery dans le même bundle que le backup courant.

Détails : [SECURITY.md](./SECURITY.md), [RUNBOOKS.md](./RUNBOOKS.md).

---

## 17. Sauvegarde et restauration

État principal :

- base SQLite : `~/.avity/avity.sqlite` (ou `AVITY_DB_PATH`) ;
- vault : `~/.avity/operator/config/credentials.vault`.

### Créer un backup certifié (control plane peut rester allumé)

```sh
install -d -m 0700 /backups/avity
read -r -s AVITY_RECOVERY_PASSPHRASE
printf '%s\n' "$AVITY_RECOVERY_PASSPHRASE" |
  avity backup create \
    --database "$HOME/.avity/avity.sqlite" \
    --output "/backups/avity/checkpoint-$(date +%F)" \
    --recovery /offline/avity-recovery/vault.recovery.json \
    --passphrase-stdin
unset AVITY_RECOVERY_PASSPHRASE
```

### Vérifier

```sh
avity backup verify \
  --bundle /backups/avity/checkpoint-YYYY-MM-DD \
  --recovery /offline/avity-recovery/vault.recovery.json \
  --passphrase-stdin
```

### Restaurer (toujours vers un **nouveau** répertoire)

```sh
avity backup restore \
  --bundle /backups/avity/checkpoint-YYYY-MM-DD \
  --destination /restore-rehearsal/avity \
  --recovery /offline/avity-recovery/vault.recovery.json \
  --confirm-bundle-id bkp_ID_VERIFIE \
  --passphrase-stdin
```

Après restore réel : reconfigurer `AVITY_DB_PATH` / `AVITY_OPERATOR_HOME` / `AVITY_VAULT_KEY_FILE`, et **ré-enrôler** les workers postérieurs au snapshot.

Guide complet : [BACKUP-RESTORE.md](./BACKUP-RESTORE.md).

---

## 18. Déploiement (une machine « serveur »)

Forme supportée aujourd’hui : **un hôte** control plane + un ou plusieurs workers.

```sh
pnpm install --frozen-lockfile && pnpm -r build

AVITY_DB_PATH=/var/lib/avity/avity.sqlite \
AVITY_HOST=127.0.0.1 AVITY_PORT=7717 \
AVITY_API_TOKEN=<jeton> \
node services/control-plane/dist/main.js
```

Bonnes pratiques :

- Superviser avec **launchd** (macOS) ou **systemd** (Linux) — templates dans `deploy/`.
- Exposer hors loopback uniquement avec **TLS** (natif ou reverse proxy).
- Stocker les credentials dans le vault.
- Builder le web (`pnpm --filter @avityos/web build`) et servir `dist/` en statique avec `VITE_AVITY_API` fixé au build.

AvityOS **ne provisionne pas** l’infra payante des projets utilisateurs sans approbation explicite.

---

## 19. Vérifier que tout fonctionne

Depuis la racine du dépôt :

```sh
pnpm verify          # build + tests + typecheck (standard)
pnpm verify:full     # + Playwright E2E + tests Swift (macOS)
pnpm licenses:check
pnpm audit --audit-level high
```

Un seul package :

```sh
pnpm --filter @avityos/control-plane test
pnpm --filter @avityos/web test:e2e
```

Playwright (première fois) :

```sh
pnpm --filter @avityos/web exec playwright install chromium
```

---

## 20. Dépannage (symptômes → actions)

### Le control plane ne démarre pas

1. `node --version` → doit être ≥ 22.5.  
2. `pnpm --filter @avityos/control-plane build` puis `start`.  
3. Port occupé : `lsof -i :7717` → changer `AVITY_PORT`.  
4. DB non writable : vérifier `AVITY_DB_PATH`.  
5. Vault : `avity vault status` — mauvaise clé maître = échec fermé avant injection des secrets.

### Le web affiche « Hors ligne »

1. Control plane tourne-t-il ?  
2. `VITE_AVITY_API` pointe-t-il vers la bonne URL ?  
3. CORS / origines : `AVITY_ALLOWED_ORIGINS` (défaut localhost:5173).  
4. Token / login navigateur : se reconnecter si le bearer a été rotaté.

### `sandbox_unavailable`

- **Linux** : installer Bubblewrap (`bwrap`).  
- **macOS** : vérifier `sandbox-exec`.  
- Ne pas chercher à « désactiver le sandbox » pour contourner : le design est fail-closed.

### Provider « not registered » / auth

```sh
avity doctor
avity provider status
```

Vérifier binaire (`AVITY_*_BIN`), clé vault, fichiers credentials autorisés uniquement.  
Une erreur d’auth n’est **pas** retryée indéfiniment sur le même provider.

### Mission bloquée

```sh
avity intervention list
avity mission list <project-id>
avity run logs <run-id>
avity logs --service worker
```

Traiter l’intervention (approuver, répondre, ajuster budget / policy), puis reprendre si le projet était en pause.

### Pause qui « n’arrête pas » un provider externe

Normal : AvityOS garantit le **fencing** (aucun résultat tardif ne s’intègre), pas le gel mémoire d’un process vendor. Vérifiez `project pause` réussi + absence de nouveaux runs.

### Campagne live bloquée

Suivre [LIVE-E2E-CAMPAIGN.md](./LIVE-E2E-CAMPAIGN.md) et [RUNBOOKS.md](./RUNBOOKS.md) : `doctor` → `provider status` → `e2e preflight` → `prepare` → `run` confirmé.

---

## 21. FAQ

**Q : Dois-je payer une IA pour tester AvityOS ?**  
Non. Le provider fake + `pnpm verify` couvrent l’orchestration. Les providers live sont optionnels.

**Q : Puis-je lancer plusieurs projets en parallèle ?**  
Oui. Les projets sont isolés. À l’intérieur d’un projet, l’ordre suit les dépendances ; entre projets, le parallèle est normal (dans les limites de capacité).

**Q : AvityOS va-t-il merger ma PR ?**  
Non. Il peut préparer une PR draft et, hors autonomie, un opérateur peut la marquer ready. Pas de self-merge.

**Q : Où sont mes données ?**  
Principalement dans SQLite (`AVITY_DB_PATH`, défaut `~/.avity/avity.sqlite`) + vault opérateur. Les worktrees de mission sont dans les dépôts gérés.

**Q : C’est quoi la différence Live / Démo ?**  
Live = connecté au vrai control plane. Démo = fixtures UI explicites. Ne jamais confondre.

**Q : Je suis perdu entre tous les fichiers `docs/` — par où commencer ?**  
Ce mode d’emploi. Ensuite : [PRODUCT.md](./PRODUCT.md) → [PROJECT-LIFECYCLE.md](./PROJECT-LIFECYCLE.md) → [LOCAL-DEVELOPMENT.md](./LOCAL-DEVELOPMENT.md).

**Q : Puis-je contribuer au code d’AvityOS ?**  
Oui — voir [CONTRIBUTING.md](../CONTRIBUTING.md) : branche dédiée, PR, pas de self-merge, `pnpm verify` avant review.

---

## 22. Où aller plus loin

| Document | Contenu |
| --- | --- |
| [README.md](../README.md) | Vue produit & quick start |
| [PRODUCT.md](./PRODUCT.md) | Contrat produit / barre qualité |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Composants, machines d’état, recovery |
| [PROJECT-LIFECYCLE.md](./PROJECT-LIFECYCLE.md) | Cycle objectif → livraison |
| [PROVIDER-ADAPTERS.md](./PROVIDER-ADAPTERS.md) | Intégrations IA & fallback |
| [POLICIES.md](./POLICIES.md) | Autonomie, budgets, checkpoints |
| [GIT-WORKFLOW.md](./GIT-WORKFLOW.md) | Branches, worktrees, PR |
| [SECURITY.md](./SECURITY.md) | Modèle de confiance & contrôles |
| [LOCAL-DEVELOPMENT.md](./LOCAL-DEVELOPMENT.md) | Environnement de dev |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Mise en prod mono-hôte |
| [BACKUP-RESTORE.md](./BACKUP-RESTORE.md) | Backup / restore certifiés |
| [RUNBOOKS.md](./RUNBOOKS.md) | Incidents & procédures |
| [TRACEABILITY.md](./TRACEABILITY.md) | Preuves / DoD |
| [ROADMAP.md](./ROADMAP.md) | Ordre des jalons produit |
| [adr/](./adr/) | Décisions d’architecture versionnées |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Contribuer au dépôt |
| [LIVE-E2E-CAMPAIGN.md](./LIVE-E2E-CAMPAIGN.md) | Campagne providers réels |

---

## Annexe A — Structure du dépôt (carte mentale)

```text
apps/
  web/                 Mission Control (React / Vite)
  cli/                 Binaire `avity`
  macos/               App SwiftUI + menu bar
services/
  control-plane/       API + moteur + SQLite
  worker/              Exécution sandboxed / baux
  remote-relay/        Relais distant (chiffré)
packages/
  contracts/           Schémas Zod — source de vérité
  orchestration/       Machines d’état, DAG, scheduler (pur)
  providers/           Adapters IA
  policy/              Permissions, chemins, rédaction secrets
  git/                 Git / worktrees sûrs
  credential-vault/    Coffre secrets opérateur
  transport-security/  TLS / mTLS
docs/                  Documentation (vous êtes ici)
deploy/                Templates launchd / systemd
scripts/               Packaging macOS, licences, etc.
```

## Annexe B — Chemin « journée type » (opérateur)

1. `avity status` / ouvrir le web → badge **Live**.  
2. `avity doctor` si doute.  
3. Créer ou ouvrir un projet.  
4. Soumettre un objectif clair + 2–5 critères mesurables.  
5. Répondre aux clarifications **une fois**, complètement.  
6. Surveiller missions / interventions (ne pas spam-retry).  
7. Relire la PR draft + preuves (checks, review).  
8. Décider manuellement du merge / ready.  
9. Backup périodique + vérifier le recovery escrow.

## Annexe C — Ce qu’il faut retenir absolument

1. **Un objectif**, pas dix chats.  
2. **Preuves avant « terminé ».**  
3. **Fake/démo ≠ livraison.**  
4. **Secrets dans le vault, jamais en argv.**  
5. **Pas de self-merge, pas d’infra payante silencieuse.**  
6. **Pause = fencing durable**, pas magie sur le process vendor.  
7. En cas de blocage : **Interventions** + `doctor` + logs — pas la panique.

---

*Fin du mode d’emploi. Si une section contredit le code ou un ADR plus récent, le code / l’ADR prime — ouvrez une PR pour corriger ce guide.*
