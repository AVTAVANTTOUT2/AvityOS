# Roadmap

L'ordre ci-dessous est obligatoire : chaque chantier stabilise les contrats et
les garanties dont dépend le suivant. Un statut ne devient ✅ qu'avec une preuve
reproductible dans `docs/TRACEABILITY.md`.

1. **✅ Onboarding complet des projets.** Création et modification Web/CLI,
   dépôt local canonicalisé et validé par le serveur, remote GitHub, branche
   principale, objectif, critères multiples, autonomie et budget persistés.
   Les validations locales et les CI Linux/macOS de la PR #30 sont
   reproductibles dans `docs/TRACEABILITY.md`.

2. **🟡 Véritable cerveau central IA.** Implémenté et couvert par des tests
   déterministes via la PR #32 : pipeline durable objectif → snapshot borné du
   dépôt → analyse structurée → architecture proposée → plan versionné/DAG
   validé déterministement → délégation par rôle, plus replanification bornée
   et idempotente à partir de preuves réelles, le tout via `ProviderAdapter`
   avec réparation bornée des sorties invalides et provenance `fake_fixture`
   explicite. Les analyses ambiguës ou infaisables bloquent avant délégation,
   les checks correspondent exactement au snapshot serveur et une
   replanification persiste atomiquement sa clé tout en retirant les
   interventions obsolètes.
   Reste pour ✅ : une exécution de planification avec un provider de
   raisonnement réel (clés opérateur), volontairement reportée au chantier 4.

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

4. **🟡 Infrastructure prête, campagne live à réaliser — Validation E2E avec
   providers réels.** Les adapters Codex, Claude Code et Cursor existent déjà.
   Le chantier doit maintenant fournir les preuves réelles suivantes sur un
   dépôt fixture externe avec credentials opérateur :
   - planification par un provider réel ;
   - mission exécutée par Codex ;
   - mission exécutée par Claude Code ;
   - mission exécutée par Cursor ;
   - reviewer différent de l'auteur ;
   - correction après rejet ;
   - fallback entre providers ;
   - push d'une branche ;
   - création d'une PR draft ;
   - aucune auto-fusion.
   Ce chantier clôturera également le critère restant du chantier 2
   (planification réelle). C'est la **prochaine priorité produit**.

5. **⚪ Non commencé comme chantier produit complet — Pont distant sécurisé.**
   Les briques réseau et worker actuelles ne constituent pas un pont distant
   E2E terminé. Restent notamment : connexion sortante, chiffrement de bout en
   bout, comptes, appareils, révocation et audit sans clair sur le relais.

6. **🟡 Client natif déjà présent, finition produit et distribution manquantes
   — Application macOS complète.** Déjà présents : SwiftUI, Keychain,
   REST/SSE, reconnexion, polling de secours, vues projets/missions/runs,
   notifications, Dock badge, menu bar, terminaux et deep links.
   Restent notamment : mode hôte complet, mode distant, tests UI, bundle
   signé, notarisation, installation propre et stratégie de mise à jour.

7. **🟡 Fondations présentes, industrialisation manquante — Durcissement de
   distribution.** Déjà présents : CI Linux et macOS, audits, licences,
   Gitleaks, SBOM, templates launchd et systemd.
   Restent notamment : coffre de secrets, sauvegarde et restauration,
   TLS/mTLS, rotation des credentials, releases versionnées, signature,
   notarisation, rollback et politique de mise à jour.

## Prochain jalon

> AvityOS réalise une livraison complète sur un dépôt fixture externe avec des
> providers réels, produit les preuves techniques, ouvre une PR draft et
> s'arrête avant la fusion.

Ce jalon clôturera :

- le chantier 2 (preuve de planification réelle) ;
- le chantier 4 (validation E2E avec providers réels).
