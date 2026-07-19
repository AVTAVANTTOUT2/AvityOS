# Roadmap

L'ordre ci-dessous est obligatoire : chaque chantier stabilise les contrats et
les garanties dont dépend le suivant. Un statut ne devient ✅ qu'avec une preuve
reproductible dans `docs/TRACEABILITY.md`.

1. **✅ Onboarding complet des projets.** Création et modification Web/CLI,
   dépôt local canonicalisé et validé par le serveur, remote GitHub, branche
   principale, objectif, critères multiples, autonomie et budget persistés.
   Les validations locales et les CI Linux/macOS de la PR d'onboarding sont
   reproductibles dans `docs/TRACEABILITY.md`.
2. **🟡 Véritable cerveau IA.** Implémenté et couvert par des tests
   déterministes : pipeline durable objectif → snapshot borné du dépôt →
   analyse structurée → architecture proposée → plan versionné/DAG validé
   déterministement → délégation par rôle, plus replanification bornée et
   idempotente à partir de preuves réelles (révision d'objectif, mission
   échouée après correction), le tout via `ProviderAdapter` avec réparation
   bornée des sorties invalides et provenance `fake_fixture` explicite.
   Les analyses ambiguës ou infaisables bloquent avant délégation, les checks
   correspondent exactement au snapshot serveur et une replanification
   persiste atomiquement sa clé tout en retirant les interventions obsolètes.
   Reste pour ✅ : une exécution de planification avec un provider de
   raisonnement réel (clés opérateur), volontairement reportée au chantier 4.
3. **🟡 Clarifications groupées et pause/reprise atomique.** Clarifications
   structurées via `ProviderAdapter` (schéma Zod versionné, groupe unique par
   tour, réponses transactionnelles/idempotentes, obsolescence à la révision
   d’objectif, reprise exacte du pipeline cerveau) et pause projet atomique
   (demande durable, annulation des runs, révocation des leases, fencing des
   résultats tardifs, reprise idempotente après redémarrage). Web/CLI branchés
   sur les vraies API. Preuves locales dans `docs/TRACEABILITY.md`. Reste pour
   ✅ : CI Linux/macOS vertes sur la PR de ce chantier, plus preuves Playwright
   du panneau de clarification et des boutons pause/reprise sur le flux
   navigateur réel (les tests control-plane/API/CLI et Vitest Web couvrent déjà
   les contrats et l’activation des contrôles).
4. **⚪ Validation E2E avec Codex, Claude Code et Cursor réels.** Scénarios
   reproductibles sur des dépôts fixtures externes et preuves de livraison.
5. **⚪ Pont distant sécurisé.** Connexion sortante, chiffrement de bout en
   bout, comptes, appareils, révocation et audit sans clair sur le relais.
6. **⚪ Application macOS complète.** Modes hôte et distant, contrôle du cycle
   de vie, interventions, terminaux et état de connexion explicite.
7. **⚪ Durcissement de distribution.** Coffre de secrets, sauvegardes,
   TLS/mTLS, signature et notarisation.
