# Preuves live E2E — 23 juillet 2026

Ce relevé fige les preuves obtenues pendant la campagne réelle
`Live DeepSeek Codex Delivery`. Il distingue les scénarios effectivement
réussis des scénarios encore bloqués par la configuration opérateur.

## Périmètre

| Élément | Valeur |
| --- | --- |
| Projet AvityOS | `prj_3c7da8aed59048adaade` |
| Objectif | Ajouter `normalizeIncident(input)` en JavaScript et TypeScript, avec tests et documentation |
| Dépôt fixture | [`AVTAVANTTOUT2/avity-live-e2e-fixture`](https://github.com/AVTAVANTTOUT2/avity-live-e2e-fixture) |
| Baseline `main` | `379bb54c09d3b8dbc80c868647b6db5b76d42fee` |
| Plan actif | `pln_2e874749b7e64dddae95`, version 1 |
| Résultat final | Projet et quatre missions `completed` |

Les identifiants ci-dessous sont relisibles avec les commandes publiques :

```sh
avity project show prj_3c7da8aed59048adaade --json
avity brain show prj_3c7da8aed59048adaade --json
avity mission list prj_3c7da8aed59048adaade --json
avity run list --project prj_3c7da8aed59048adaade --json
```

## Cerveau central réel

DeepSeek `deepseek-v4-pro` a exécuté le pipeline avec la provenance `live` :

| Étape | Run | Résultat | Tokens entrée / sortie |
| --- | --- | --- | --- |
| Analyse | `brr_7b8cb02462334206a124` | `succeeded` | 1 386 / 2 835 |
| Architecture | `brr_0aaf4feaf09540e7935b` | `succeeded` | 2 437 / 3 834 |
| Plan, tentative réparée | `brr_99252ffe79284efcbea9` | `succeeded` | 5 475 / 4 320 |

Le plan durable résultant contient quatre jalons ordonnés et a délégué les
missions. Cette preuve clôt le dernier critère du chantier 2 : la
planification n'est plus démontrée uniquement avec le provider fixture.

## Exécution, revue et publication

| Preuve | Résultat observé |
| --- | --- |
| Mission d'édition Codex | `msn_d6f4cd1e834a485a9ba3` terminée ; commit `abf311aaa713439667835ef65dab500b4841c911` |
| Revue distincte Codex → DeepSeek | `run_7e239008c0474ba4a0f7`, `review completed` |
| Mission read-only DeepSeek | `run_5271a8cc72264118ac22`, `succeeded` |
| Revue distincte DeepSeek → Codex | `run_de02b78d208a4d1a8278`, `review completed`, verdict final `APPROVE` |
| Checks finaux | `pnpm acceptance`, `test` (7/7), `lint` et `typecheck`, tous code 0 |
| État final | Projet `completed`, aucun run actif, aucune intervention ouverte |

La revue finale cite les deux choix de verdict dans son prompt puis se termine
par `VERDICT: APPROVE`. AvityOS retient bien ce dernier verdict explicite, ce
qui reproduit en campagne le correctif de la PR #68. Le control plane est
resté disponible pendant toute la reprise et la clôture après le correctif
d'annulation HTTP de la PR #69.

Le checkpoint documentaire a été fusionné par la
[PR #70](https://github.com/AVTAVANTTOUT2/AvityOS/pull/70). Son commit sur
`main` a ensuite repassé la
[CI macOS](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/30053975061)
et la
[CI Linux](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/30053975096).

AvityOS a poussé trois branches et créé trois PR draft, toutes laissées ouvertes
et non fusionnées :

| PR | Mission | État vérifié |
| --- | --- | --- |
| [fixture #1](https://github.com/AVTAVANTTOUT2/avity-live-e2e-fixture/pull/1) | Implémentation JS/TS | `OPEN`, `draft`, base `main` |
| [fixture #2](https://github.com/AVTAVANTTOUT2/avity-live-e2e-fixture/pull/2) | Tests JS/TS | `OPEN`, `draft`, base `main` |
| [fixture #3](https://github.com/AVTAVANTTOUT2/avity-live-e2e-fixture/pull/3) | Documentation | `OPEN`, `draft`, base `main` |

La baseline de `main` n'a pas été modifiée. Ces PR sont des artefacts de preuve
et ne doivent pas être fusionnées.

## Matrice du chantier 4

| Scénario obligatoire | État | Preuve ou manque exact |
| --- | --- | --- |
| Planification par un provider réel | ✅ | Pipeline DeepSeek et plan actif ci-dessus |
| Mission Codex | ✅ | Mission d'implémentation terminée |
| Mission Claude Code | ⚪ | Credential sandbox-portable absent |
| Mission Cursor | ⚪ | Credential sandbox-portable absent |
| Reviewer différent de l'auteur | ✅ | Codex → DeepSeek et DeepSeek → Codex |
| Correction après rejet | 🟡 | Boucle réelle observée, mais déclenchée par l'ancien parseur de verdict ; un rejet fonctionnel volontaire reste à certifier |
| Fallback entre providers | 🟡 | Des échecs d'auth Claude → Codex ont été observés, mais ne constituent pas une preuve certifiante entre providers prêts. Le preflight E2E déclare le scénario exécutable via la chaîne de raisonnement DeepSeek/Codex ; aucun événement live de fallback injecté n'a encore été certifié |
| Push d'une branche | ✅ | Trois branches distantes publiées |
| Création d'une PR draft | ✅ | Trois PR draft ouvertes |
| Aucune auto-fusion | ✅ | Les trois PR restent ouvertes ; aucun chemin de merge dans le runner |

Le chantier 4 reste donc ouvert. Sa clôture exige une campagne certifiante avec
Claude Code et Cursor authentifiés, un fallback live entre deux providers prêts
(cerveau ou mission) et un rejet fonctionnel délibéré suivi d'une correction
validée. L'indicateur `provider status` de fallback mission reste séparément
bloqué tant qu'une même chaîne de rôle ne contient pas deux éditeurs prêts.
