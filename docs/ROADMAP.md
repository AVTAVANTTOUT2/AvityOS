# Roadmap

L'ordre ci-dessous est obligatoire : chaque chantier stabilise les contrats et
les garanties dont dépend le suivant. Un statut ne devient ✅ qu'avec une preuve
reproductible dans `docs/TRACEABILITY.md`.

1. **✅ Onboarding complet des projets.** Création et modification Web/CLI,
   dépôt local canonicalisé et validé par le serveur, remote GitHub, branche
   principale, objectif, critères multiples, autonomie et budget persistés.
   Les validations locales et les CI Linux/macOS de la PR #30 sont
   reproductibles dans `docs/TRACEABILITY.md`.

2. **✅ Véritable cerveau central IA.** Implémenté et couvert par des tests
   déterministes via la PR #32 : pipeline durable objectif → snapshot borné du
   dépôt → analyse structurée → architecture proposée → plan versionné/DAG
   validé déterministement → délégation par rôle, plus replanification bornée
   et idempotente à partir de preuves réelles, le tout via `ProviderAdapter`
   avec réparation bornée des sorties invalides et provenance `fake_fixture`
   explicite. Les analyses ambiguës ou infaisables bloquent avant délégation,
   les checks correspondent exactement au snapshot serveur et une
   replanification persiste atomiquement sa clé tout en retirant les
   interventions obsolètes. La campagne du 23 juillet 2026 a produit avec
   DeepSeek, provenance `live`, l'analyse, l'architecture et un plan actif de
   quatre jalons ensuite livré. Les identifiants reproductibles sont consignés
   dans [`LIVE-E2E-EVIDENCE-2026-07-23.md`](./LIVE-E2E-EVIDENCE-2026-07-23.md).

3. **✅ Terminé — Clarifications structurées et pause/reprise atomique.**
   Fusionné par la PR #35. Trois invariants prouvés :
   - **P-ISO** : isolation stricte par projet lors de la révocation des
     leases (`revokeProjectWorkerLeases` ne touche jamais les sessions d'un
     autre projet sur le même worker) ;
   - **P-FENCE** : résultats anciens refusés après pause ou changement de
     génération, y compris pour les workflows asynchrones (`validate`,
     `review`, `integrate`, checks worker) ;
   - **P-RESUME** : reprise durable après clarification via `resume_pending`,
     idempotente par question et réconciliée au redémarrage ou reprise
     explicite.
   Migrations SQLite v6 (`project_pauses`, métadonnées de clarification,
   `missions.paused_from_state`) et v7 (`clarifications.resume_pending`).
   Preuves locales, tests de concurrence
   (`chantier3-hardening.test.ts`, 21 tests), CI Linux et macOS vertes,
   Web/CLI branchés sur les vraies API.

4. **🟡 Campagne partielle réussie — Validation E2E avec providers réels.**
   La campagne du 23 juillet 2026 prouve la planification réelle DeepSeek,
   l'exécution Codex, des revues indépendantes dans les deux sens, les checks
   finaux, le push de trois branches et la création de trois PR draft jamais
   fusionnées. Les preuves et limites exactes sont consignées dans
   [`LIVE-E2E-EVIDENCE-2026-07-23.md`](./LIVE-E2E-EVIDENCE-2026-07-23.md).
   La campagne du 24 juillet ajoute une preuve certifiante
   DeepSeek → Codex (`ev_1b3ba1cc91114d26bd90`) et valide en conditions
   réelles l'escalade sûre d'une revue rejetée à `3/3` après la PR #74 ;
   voir
   [`LIVE-E2E-EVIDENCE-2026-07-24.md`](./LIVE-E2E-EVIDENCE-2026-07-24.md).
   Restent obligatoires pour ✅ :
   - mission exécutée par Claude Code ;
   - mission exécutée par Cursor ;
   - rejet fonctionnel volontaire suivi d'une correction validée ;
   C'est la **prochaine priorité produit**.

5. **✅ Cœur livré — Pont distant sécurisé.**
   Le checkpoint 5.1 définit les contrats stricts, la racine de confiance
   compte/appareil, les certificats Ed25519, l'appairage chiffré par secret
   hors bande et les enveloppes E2E X25519 + HKDF-SHA-256 + AES-256-GCM,
   signées et protégées contre le rejeu. Le checkpoint 5.2 ajoute le service
   relais ciphertext-only borné, le long-poll/ack et un connecteur hôte qui
   n'ouvre que des connexions sortantes, avec preuve réseau aller-retour sans
   clair sur le relais. Le checkpoint 5.3 rend comptes/appareils, inboxes,
   déduplication et curseurs durables dans SQLite, sépare token administrateur
   et credentials par appareil, applique la révocation immédiate, consomme
   l'appairage atomiquement et chaîne l'audit local des actions distantes.
   L'expérience native d'appairage et de mode distant appartient au chantier 6.

6. **🟡 Client natif déjà présent, finition produit et distribution manquantes
   — Application macOS complète.** Déjà présents : SwiftUI, Keychain,
   REST/SSE, reconnexion, polling de secours, vues projets/missions/runs,
   notifications, Dock badge, menu bar, terminaux et deep links. Le checkpoint
   6.1 aligne le client sur les contrats réels (dont `TerminalSession.command`),
   impose HTTPS hors loopback, conserve les erreurs API structurées, reprend
   SSE par curseur et couvre transport/actions avec des tests déterministes.
   Le checkpoint 6.2 livre le mode hôte macOS : identités et credentials dans
   Keychain, état public/rejeu/audit durable, API locale d'administration,
   appairage à usage unique avec bootstrap du token appareil chiffré, révocation
   et connecteur strictement sortant limité aux lectures natives et à la
   résolution d'approbations, avec écran Réglages associé. Le checkpoint 6.3
   livre le mode appareil distant natif : CryptoKit interopérable avec le
   protocole Node, identité/certificats/bearer/curseurs dans Keychain,
   appairage offre → requête → bootstrap, transport relay publish/poll/ack
   reprenable après crash et réutilisation des écrans existants en mode
   chiffré. Restent notamment : tests UI, bundle signé, notarisation,
   installation propre, renouvellement des certificats et stratégie de mise à
   jour.

7. **🟡 Fondations présentes, industrialisation manquante — Durcissement de
   distribution.** Déjà présents : CI Linux et macOS, audits, licences,
   Gitleaks, SBOM, templates launchd et systemd.
   Restent notamment : coffre de secrets, sauvegarde et restauration,
   TLS/mTLS, rotation des credentials, releases versionnées, signature,
   notarisation, rollback et politique de mise à jour.

## Prochain jalon

> AvityOS termine la campagne certifiante sur un dépôt fixture externe avec
> Claude Code et Cursor, puis obtient une correction fonctionnelle approuvée
> après rejet. Le fallback réel DeepSeek → Codex est déjà certifié. Les PR de
> preuve restent ouvertes et ne sont jamais fusionnées.

Ce jalon clôturera :

- le chantier 4 (validation E2E avec providers réels).

## Maintenance défensive (hors chantiers produit)

Ces travaux ne ferment aucun chantier produit. Ils durcissent des invariants
déjà livrés :

- **Post-audit preflight / readiness (PR #41)** — invariants de contrat E2E
  (`realProviderCount`, `realWorkspaceEditorCount`, unicité des providers) et
  éviction des Promises rejetées du cache GitHub readiness.
- **Cohérence runtime providers / sandbox** — catégorie
  `sandbox_unavailable`, tests unitaires hermétiques du command adapter, suites
  d’intégration OS séparées ; pas de fallback non sandboxé.
