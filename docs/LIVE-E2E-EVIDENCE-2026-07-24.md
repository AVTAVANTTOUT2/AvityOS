# Preuves live E2E — 24 juillet 2026

Ce relevé complète la campagne du 23 juillet avec la campagne réelle
`Live Ready-Provider Fallback`. Il sépare strictement la preuve de fallback
acquise, la robustesse du control plane désormais validée et la correction
fonctionnelle qui reste incomplète.

## Périmètre

| Élément | Valeur |
| --- | --- |
| Projet AvityOS | `prj_5beb93d72384489b80f1` |
| Objectif | Certifier le fallback réel et une correction fonctionnelle bornée |
| Dépôt fixture | [`AVTAVANTTOUT2/avity-live-e2e-fixture`](https://github.com/AVTAVANTTOUT2/avity-live-e2e-fixture) |
| Baseline `main` | `379bb54c09d3b8dbc80c868647b6db5b76d42fee` |
| PR de preuve | [fixture #4](https://github.com/AVTAVANTTOUT2/avity-live-e2e-fixture/pull/4), ouverte, draft, jamais fusionnée |
| Résultat actuel | Projet `active`, mission de correction `failed`, intervention opérateur ouverte |

## Fallback certifié

La chaîne de raisonnement a démarré une analyse réelle sur DeepSeek, enregistré
sa panne contrôlée puis basculé immédiatement vers Codex :

| Preuve | Résultat observé |
| --- | --- |
| Run DeepSeek | `brr_87d42b3130cd4d9c8074`, `analysis`, `failed`, provenance `live` |
| Événement certifiant | `ev_1b3ba1cc91114d26bd90`, séquence `2254` |
| Action | `switch_provider`, DeepSeek → Codex, attente `0 ms` |
| Reprise Codex | `brr_8a9ce6bfc74e49bbb5cd`, `analysis`, `succeeded`, provenance `live` |

Le payload durable de l'événement est :

```json
{
  "phase": "brain",
  "step": "analysis",
  "provider": "deepseek",
  "category": "auth",
  "action": "switch_provider",
  "waitMs": 0,
  "reason": "provider authentication unavailable; switching provider without retry"
}
```

Une seconde séquence a épuisé quatre tentatives DeepSeek
`transient_network` sur l'architecture, puis a enregistré
`ev_b8f3ed7630964023b116` (`switch_provider`) avant le succès Codex
`brr_e98848f93fa5443a82ef`. La campagne prouve donc le comportement réel
retry borné → changement de provider → reprise du pipeline.

Cette preuve clôt le scénario de fallback live demandé par le chantier 4. Elle
ne prouve pas que la clé DeepSeek est encore utilisable après la campagne :
les appels ultérieurs retournent actuellement HTTP 401 et doivent être
recertifiés après rotation du credential.

## Rejet et correction : preuve exacte

La première version du plan a réellement produit le défaut attendu sur
`msn_2eb48dbd6a214e39a9dd` :

- `formatCorrectionSummary` a renvoyé `FIX: retry worker bootstrap` au lieu de
  `FIX: INC-404 retry worker bootstrap` ;
- le test réel a échoué avec code 1 et le diff attendu/réel a été conservé
  dans `ev_a66f670a75fd417b85f6` ;
- les trois corrections bornées ont été exécutées ;
- aucune n'a restauré l'invariant, donc la mission a fini `failed` et déclenché
  un replan v2. Ce résultat est une preuve négative, pas une correction réussie.

La mission v2 `msn_505da42f7cca48e4bfb9` a ensuite passé les checks
déterministes, mais le reviewer a correctement rejeté ses quatre versions :
l'historique ne contient pas le défaut initial demandé et l'arbre final est
identique à la baseline. Après `3/3` corrections, cette dernière revue a exposé
un défaut du control plane : la transition
`review_required → failed` manquait et faisait tomber le processus.

La [PR #74](https://github.com/AVTAVANTTOUT2/AvityOS/pull/74) a ajouté la
transition et sa régression. Après fusion et redémarrage sur `main`, la même
mission a été revue à nouveau puis a produit :

| Preuve | Résultat observé |
| --- | --- |
| Mission | `msn_505da42f7cca48e4bfb9`, `failed`, corrections `3/3` |
| Transition | `ev_3c605a4fb564440fa51e`, `review_required → failed` |
| Intervention | `apr_c8da488535ee4950a8fb`, `Correction limit reached`, ouverte |
| Disponibilité | Control plane toujours prêt, aucun run actif après la transition |

La robustesse de l'escalade après épuisement est donc validée en conditions
réelles. En revanche, le critère « rejet fonctionnel suivi d'une correction
validée » reste ouvert : ni une boucle épuisée ni un résultat final sans diff
ne peuvent être présentés comme un succès.

## Correctif de liveness worker

La campagne avait accumulé dix anciennes identités worker persistées
`online`. La [PR #75](https://github.com/AVTAVANTTOUT2/AvityOS/pull/75)
aligne l'affichage sur la fenêtre de heartbeat utilisée par l'ordonnanceur,
sans réécrire l'état durable. La vérification live après déploiement donne
exactement un worker `online` et dix workers `offline`.

## État restant du chantier 4

| Scénario obligatoire | État | Preuve ou manque exact |
| --- | --- | --- |
| Planification par un provider réel | ✅ | Campagne DeepSeek du 23 juillet et reprises Codex du 24 |
| Mission Codex | ✅ | Plusieurs runs d'édition `succeeded` |
| Mission Claude Code | ⚪ | Credential sandbox-portable absent |
| Mission Cursor | ⚪ | Credential sandbox-portable absent |
| Reviewer différent de l'auteur | ✅ | Campagne du 23 juillet |
| Correction après rejet | 🟡 | Rejet et boucles réels, mais aucune correction finale approuvée |
| Fallback entre providers | ✅ | `ev_1b3ba1cc91114d26bd90` et reprise Codex |
| Push et PR draft | ✅ | Fixture #4 ouverte et non fusionnée |
| Aucune auto-fusion | ✅ | Toutes les PR de preuve restent ouvertes |

Le chantier 4 reste ouvert uniquement pour les exécutions Claude Code/Cursor
et une correction fonctionnelle finalement approuvée. DeepSeek doit aussi être
recertifié après remplacement de sa clé actuellement refusée au runtime.
