Conçois l’interface complète haute fidélité d’« AvityOS », un système d’exploitation permettant à une seule personne de piloter plusieurs projets logiciels entièrement réalisés par des équipes d’agents IA autonomes.

OBJECTIF PRODUIT

L’utilisateur donne un objectif. AvityOS planifie, délègue, exécute, teste, révise et livre le projet. Il ne sollicite l’utilisateur que lorsqu’une clarification ou une validation importante est nécessaire.

AvityOS centralise :
- plusieurs projets parallèles et totalement isolés ;
- équipes IA frontend, backend, infrastructure, cybersécurité, QA et architecture ;
- Codex, Claude Code, Cursor CLI, DeepSeek et autres providers ;
- terminaux et sessions d’agents ;
- dépôts locaux et GitHub ;
- branches, worktrees, commits, PR et reviews ;
- plans, missions, checkpoints, tests et déploiements ;
- consommation de tokens, budgets, rate limits et bascule automatique de provider.

Créer deux interfaces cohérentes :
1. Une application Web desktop en 1440 × 1024.
2. Une application macOS native en 1512 × 982.

Les fonctionnalités restent identiques, mais l’application macOS doit réellement ressembler à une application Apple native.

DIRECTION ARTISTIQUE

Style macOS Liquid Glass moderne :
- thème clair blanc et crème ;
- fond principal crème très clair #F7F4EE ;
- surfaces blanches semi-transparentes ;
- panneaux avec backdrop blur et légère réfraction ;
- bordures blanches internes très fines ;
- ombres diffuses, douces et peu visibles ;
- coins arrondis entre 12 et 20 px ;
- beaucoup d’espace et une excellente lisibilité ;
- texte principal graphite #202124 ;
- texte secondaire gris chaud #74716B ;
- accent principal bleu indigo discret #5267D9 ;
- vert doux pour les succès ;
- orange doux pour les attentes ;
- rouge corail pour les erreurs critiques ;
- aucune esthétique cyberpunk, aucun néon, aucun effet gaming ;
- interface calme, premium, précise et épurée ;
- utiliser SF Pro sur macOS et Inter/SF Pro sur le Web ;
- icônes fines inspirées de SF Symbols ;
- graphiques simples, lisibles et peu chargés.

Créer un logo typographique minimal « AvityOS » accompagné d’un symbole abstrait représentant un noyau central orchestrant plusieurs unités.

NAVIGATION GLOBALE

Sidebar principale :
- Vue générale
- Projets
- Interventions
- Agents
- Exécutions
- GitHub
- Providers
- Activité
- Paramètres

Partie basse :
- état du système ;
- consommation globale ;
- profil utilisateur ;
- aide.

Barre supérieure :
- projet courant ;
- recherche globale ;
- palette de commandes ;
- bouton « Nouvel objectif » ;
- notifications ;
- état de synchronisation local/GitHub.

Créer une palette de commandes accessible avec ⌘K permettant :
- créer un projet ;
- ouvrir un projet ;
- rechercher une mission ;
- lancer ou arrêter une exécution ;
- répondre à une question ;
- ouvrir un terminal ;
- consulter une PR.

ÉCRAN 1 — ONBOARDING

Créer un onboarding en plusieurs étapes :
1. Bienvenue dans AvityOS.
2. Connexion à GitHub.
3. Choix du dossier de travail local.
4. Connexion des providers IA.
5. Configuration du niveau d’autonomie.
6. Règles de sécurité et validations humaines.
7. Projet de démonstration facultatif.

Champs :
- nom de l’espace de travail ;
- dossier local ;
- compte ou organisation GitHub ;
- providers activés ;
- clés API masquées ;
- budget mensuel global ;
- autorisation de bascule automatique ;
- validations humaines obligatoires ;
- notifications.

Afficher clairement la progression et permettre de reprendre plus tard.

ÉCRAN 2 — MISSION CONTROL / VUE GLOBALE

Créer un tableau de bord très lisible avec :
- nombre de projets actifs ;
- projets terminés ;
- agents actuellement actifs ;
- interventions demandées ;
- PR en attente ;
- état des providers ;
- consommation quotidienne et mensuelle.

Afficher les projets sous forme de cartes :
- nom ;
- objectif court ;
- phase actuelle ;
- progression ;
- santé du projet ;
- agents actifs ;
- dernière activité ;
- branche principale ;
- prochain checkpoint ;
- coût actuel.

Ajouter :
- activité récente ;
- questions urgentes ;
- projets bloqués ;
- prochaines livraisons ;
- graphique minimal de consommation ;
- bouton « Donner un nouvel objectif ».

Exemples de projets :
- Application SaaS de facturation ;
- Plateforme de réservation ;
- API d’automatisation financière ;
- Application mobile de suivi sportif.

ÉCRAN 3 — CRÉATION D’UN PROJET

Créer un formulaire guidé centré sur l’objectif.

Champ principal très visible :
« Que voulez-vous construire ? »

Champs complémentaires :
- nom du projet ;
- description détaillée ;
- résultat final attendu ;
- nouveau dépôt ou dépôt existant ;
- dépôt GitHub ;
- organisation GitHub ;
- visibilité publique ou privée ;
- dossier local ;
- fichiers ou documents de référence ;
- priorité ;
- date cible facultative ;
- technologies imposées ou libres ;
- providers autorisés ;
- budget maximal ;
- niveau d’autonomie ;
- niveau de qualité ;
- environnements nécessaires ;
- autoriser ou non le déploiement automatique.

Niveaux d’autonomie :
- Supervisé ;
- Autonome avec checkpoints ;
- Autonomie maximale.

Afficher avant lancement :
- résumé de compréhension généré par AvityOS ;
- questions éventuelles ;
- proposition de première phase ;
- risques identifiés ;
- estimation indicative ;
- bouton « Lancer le projet ».

ÉCRAN 4 — VUE D’ENSEMBLE D’UN PROJET

Header :
- nom et icône du projet ;
- statut ;
- phase actuelle ;
- progression globale ;
- santé ;
- dépôt GitHub ;
- branche principale ;
- bouton pause/reprise ;
- bouton ouvrir localement ;
- menu d’actions.

Navigation interne :
- Vue d’ensemble
- Plan
- Missions
- Équipe
- Exécutions
- Code & PR
- Infrastructure
- Sécurité
- Cerveau
- Paramètres

Contenu :
- objectif principal ;
- résumé actuel produit par le cerveau central ;
- étape en cours ;
- prochaines étapes ;
- agents actifs ;
- missions récentes ;
- PR ouvertes ;
- tests et qualité ;
- derniers déploiements ;
- risques ;
- décisions utilisateur attendues ;
- timeline du projet.

ÉCRAN 5 — PLAN DU PROJET

Afficher :
- phases ;
- milestones ;
- tâches ;
- dépendances ;
- checkpoints ;
- critères de réussite ;
- risques ;
- décisions d’architecture.

Proposer deux vues :
- roadmap chronologique ;
- graphe visuel des dépendances.

Chaque phase affiche :
- objectif ;
- statut ;
- progression ;
- propriétaire IA ;
- dépendances ;
- livrables ;
- validations nécessaires.

Ajouter :
- « Demander une révision du plan » ;
- historique des changements ;
- comparaison entre ancien et nouveau plan ;
- justification donnée par l’orchestrateur.

ÉCRAN 6 — MISSIONS

Créer un tableau Kanban propre avec :
- À planifier
- Prête
- En cours
- En validation
- PR ouverte
- Bloquée
- Terminée

Chaque carte contient :
- identifiant ;
- titre ;
- équipe ;
- agent assigné ;
- priorité ;
- dépendances ;
- durée ;
- branche ;
- état des tests.

Au clic, ouvrir un inspecteur latéral avec :
- objectif ;
- contexte ;
- critères d’acceptation ;
- fichiers autorisés ;
- actions interdites ;
- dépendances ;
- agent et provider ;
- worktree ;
- branche ;
- commits ;
- tests ;
- résultats ;
- risques ;
- historique ;
- boutons pause, réassigner, relancer ou annuler.

ÉCRAN 7 — ÉQUIPE IA

Présenter l’organisation du projet :
- cerveau central ;
- architecte ;
- lead frontend ;
- lead backend ;
- infrastructure ;
- cybersécurité ;
- QA/review ;
- agents exécutants.

Créer une vue organigramme et une vue liste.

Pour chaque agent :
- nom ;
- rôle ;
- modèle/provider ;
- mission actuelle ;
- statut ;
- contexte utilisé ;
- coût ;
- durée ;
- taux de réussite ;
- dernière activité ;
- permissions ;
- bouton consulter la session.

Statuts :
- disponible ;
- planification ;
- exécution ;
- validation ;
- en attente ;
- bloqué ;
- hors ligne.

ÉCRAN 8 — EXÉCUTIONS ET TERMINAUX

Créer une interface permettant d’ouvrir autant de sessions que nécessaire :
- grille de terminaux ;
- vue liste ;
- recherche ;
- filtres par projet, équipe, agent, provider et statut.

Chaque session affiche :
- agent ;
- mission ;
- provider ;
- terminal en direct ;
- durée ;
- tokens consommés ;
- branche/worktree ;
- commande actuelle ;
- dernière sortie ;
- état de santé.

Actions :
- ouvrir en plein écran ;
- pause ;
- reprise ;
- arrêter ;
- redémarrer ;
- réassigner à un autre provider ;
- envoyer une instruction ;
- télécharger les logs ;
- ouvrir la mission associée.

Prévoir un état « Rate limit atteint » avec :
- temps avant réinitialisation ;
- provider concerné ;
- bascule automatique proposée ;
- bouton « Basculer maintenant ».

ÉCRAN 9 — CODE, GIT ET PULL REQUESTS

Afficher :
- état du dépôt local ;
- synchronisation GitHub ;
- branches ;
- worktrees ;
- commits récents ;
- PR ouvertes ;
- conflits ;
- checks CI ;
- couverture de tests.

Liste des PR avec :
- titre ;
- mission associée ;
- auteur IA ;
- reviewers IA ;
- branche ;
- fichiers modifiés ;
- risque ;
- tests ;
- sécurité ;
- statut.

Créer une page détail de PR avec :
- résumé ;
- diff visuel ;
- fichiers ;
- commentaires de review ;
- architecture impactée ;
- résultats CI ;
- rapport sécurité ;
- score de confiance ;
- actions demander des corrections, approuver ou fusionner.

L’interface doit montrer clairement qu’un agent ne peut pas valider seul son propre travail.

ÉCRAN 10 — INTERVENTIONS UTILISATEUR

Créer une inbox centrale contenant uniquement les décisions nécessitant réellement l’utilisateur.

Types :
- question de clarification ;
- choix produit ;
- changement d’architecture majeur ;
- autorisation sensible ;
- dépassement de budget ;
- déploiement en production ;
- conflit impossible à résoudre automatiquement.

Chaque intervention affiche :
- projet ;
- question ;
- raison de la demande ;
- impact ;
- options recommandées ;
- recommandation d’AvityOS ;
- niveau d’urgence ;
- agents bloqués ;
- champ de réponse libre ;
- pièces jointes ;
- boutons répondre, approuver, refuser ou reporter.

Après réponse, afficher :
« AvityOS reprend automatiquement le projet avec cette décision. »

ÉCRAN 11 — INFRASTRUCTURE ET DÉPLOIEMENTS

Afficher :
- environnements local, développement, staging et production ;
- services ;
- bases de données ;
- workers ;
- domaines ;
- état des ressources ;
- CI/CD ;
- derniers déploiements ;
- incidents ;
- logs ;
- métriques principales.

Chaque déploiement contient :
- version ;
- commit ;
- environnement ;
- date ;
- initiateur ;
- tests ;
- statut ;
- rollback disponible.

Actions :
- déployer ;
- approuver ;
- suspendre ;
- rollback ;
- consulter les logs.

ÉCRAN 12 — QUALITÉ ET CYBERSÉCURITÉ

Créer un tableau de contrôle regroupant :
- tests ;
- couverture ;
- lint ;
- type checking ;
- dépendances vulnérables ;
- secrets détectés ;
- analyse statique ;
- conformité architecturale ;
- threat model ;
- incidents.

Afficher les résultats par sévérité :
- critique ;
- élevée ;
- moyenne ;
- faible.

Chaque problème contient :
- description ;
- fichier ou service ;
- preuve ;
- impact ;
- agent assigné ;
- correction proposée ;
- statut ;
- lien vers la mission corrective.

ÉCRAN 13 — CERVEAU DU PROJET

Créer une page représentant la mémoire structurée du projet :
- vision ;
- objectifs ;
- contraintes ;
- architecture ;
- décisions ;
- ADR ;
- contrats ;
- conventions ;
- connaissances apprises ;
- risques connus ;
- questions ouvertes.

Ajouter :
- recherche sémantique ;
- timeline des décisions ;
- liens vers commits, PR et missions ;
- bouton proposer une correction ;
- indication claire de la source de chaque information.

Éviter de représenter le cerveau comme un simple chat.

ÉCRAN 14 — PROVIDERS ET CONSOMMATION

Cartes pour :
- OpenAI / Codex ;
- Anthropic / Claude ;
- Cursor ;
- DeepSeek ;
- providers personnalisés.

Chaque carte affiche :
- connexion ;
- modèles disponibles ;
- santé ;
- latence ;
- rate limit ;
- tokens ;
- coût ;
- missions en cours ;
- ordre de fallback.

Paramètres :
- clé API masquée ;
- modèles autorisés ;
- budget ;
- seuil d’alerte ;
- limites journalières ;
- priorité ;
- stratégie de bascule automatique ;
- missions ou rôles autorisés.

Créer une vue consommation :
- aujourd’hui ;
- semaine ;
- mois ;
- par projet ;
- par agent ;
- par provider ;
- prévision de fin de mois.

ÉCRAN 15 — JOURNAL D’ACTIVITÉ

Créer un audit log chronologique avec :
- date ;
- projet ;
- agent ;
- événement ;
- action ;
- résultat ;
- coût ;
- lien vers la preuve.

Filtres :
- projet ;
- agent ;
- type d’action ;
- criticité ;
- période ;
- succès ou erreur.

Les actions sensibles doivent être facilement identifiables.

ÉCRAN 16 — PARAMÈTRES

Sections :
- profil ;
- apparence ;
- notifications ;
- GitHub ;
- stockage local ;
- sécurité ;
- permissions ;
- politiques Git ;
- règles de qualité ;
- déploiements ;
- sauvegardes ;
- providers ;
- intégrations.

Prévoir des règles configurables :
- protection de la branche principale ;
- nombre de reviews ;
- tests obligatoires ;
- fusion automatique ;
- validation humaine ;
- limite de budget ;
- actions interdites ;
- accès production ;
- rétention des logs.

SPÉCIFICITÉS DE L’APPLICATION MACOS

Créer une vraie fenêtre macOS avec :
- boutons rouge, jaune et vert ;
- barre de titre intégrée ;
- sidebar translucide ;
- toolbar native ;
- inspecteur latéral ;
- split views redimensionnables ;
- menus contextuels ;
- raccourcis clavier ;
- command palette ;
- notifications système ;
- badge dans le Dock.

Ajouter une petite vue « Menu Bar » facultative montrant :
- projets actifs ;
- agents actifs ;
- interventions ;
- consommation ;
- pause globale ;
- ouverture rapide d’AvityOS.

SPÉCIFICITÉS WEB

Créer :
- sidebar repliable ;
- header fixe ;
- panneaux adaptatifs ;
- mise en page responsive desktop et tablette ;
- centre de notifications ;
- navigation rapide entre projets ;
- persistance des filtres et des vues.

COMPOSANTS À CRÉER

Construire un design system Figma avec Auto Layout, variables et variants :
- boutons ;
- champs ;
- textarea ;
- select ;
- combobox ;
- tags ;
- badges de statut ;
- cartes projet ;
- cartes agent ;
- cartes mission ;
- tableaux ;
- tabs ;
- sidebar ;
- toolbar ;
- breadcrumbs ;
- modales ;
- drawers ;
- notifications ;
- tooltips ;
- terminal ;
- diff viewer ;
- timeline ;
- Kanban ;
- graphiques ;
- états vides ;
- skeleton loaders ;
- erreurs ;
- confirmations sensibles.

ÉTATS À MONTRER

Prévoir les états :
- chargement ;
- vide ;
- succès ;
- erreur ;
- hors ligne ;
- synchronisation ;
- projet en pause ;
- provider indisponible ;
- rate limit ;
- budget dépassé ;
- conflit Git ;
- intervention requise ;
- projet terminé.

PROTOTYPE

Créer les interactions principales :
1. Donner un objectif.
2. Vérifier la compréhension.
3. Lancer le projet.
4. Observer le plan généré.
5. Voir les agents travailler.
6. Ouvrir une mission et son terminal.
7. Examiner une PR.
8. Répondre à une clarification.
9. Voir le projet reprendre automatiquement.
10. Consulter la livraison finale.

Utiliser des textes réalistes en français, jamais de Lorem Ipsum.

Créer en priorité les écrans haute fidélité suivants :
- Mission Control ;
- Nouveau projet ;
- Vue projet ;
- Plan ;
- Missions ;
- Équipe IA ;
- Terminaux ;
- Code & PR ;
- Interventions ;
- Providers ;
- version macOS du Mission Control ;
- vue Menu Bar.

Le résultat doit immédiatement transmettre cette idée :
« Je donne un objectif, AvityOS organise toute une entreprise IA et me livre un résultat propre, sans que j’aie à gérer les agents, terminaux, sessions ou dépôts moi-même. »