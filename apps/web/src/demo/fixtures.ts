/**
 * Demo-mode fixtures. DataProvider exposes these only when
 * VITE_AVITY_DEMO=1; production failures remain visibly offline and never
 * substitute sample data for real control-plane state.
 */


export const PROJECTS = [
  {
    id: 1, name: "SaaS Facturation",
    goal: "Plateforme de facturation automatique avec abonnements, devis et comptabilité intégrée",
    phase: "Développement backend", progress: 67, health: "good",
    activeAgents: 4, branch: "main", lastActivity: "il y a 3 min",
    nextCheckpoint: "v0.3 API complète", cost: "€124", status: "active",
  },
  {
    id: 2, name: "Plateforme Réservation",
    goal: "Système de réservation multi-établissements avec paiements et notifications temps réel",
    phase: "Tests & QA", progress: 89, health: "warning",
    activeAgents: 2, branch: "main", lastActivity: "il y a 12 min",
    nextCheckpoint: "Mise en production", cost: "€287", status: "active",
  },
  {
    id: 3, name: "API Finance",
    goal: "Connecteur open banking et rapprochement comptable automatisé",
    phase: "Revue sécurité", progress: 41, health: "blocked",
    activeAgents: 0, branch: "feature/security", lastActivity: "il y a 2h",
    nextCheckpoint: "Audit pentest", cost: "€89", status: "blocked",
  },
  {
    id: 4, name: "App Mobile Sport",
    goal: "Suivi d'entraînement personnalisé avec coaching IA et nutrition",
    phase: "Conception UI", progress: 23, health: "good",
    activeAgents: 3, branch: "main", lastActivity: "il y a 8 min",
    nextCheckpoint: "Maquettes validées", cost: "€56", status: "active",
  },
];

export const AGENTS = [
  { id: 1, name: "Cerveau Central", role: "Orchestrateur", model: "Claude Opus 4", status: "execution", mission: "Coordination sprint #7", context: "142k / 200k", cost: "€34.20", successRate: 97, project: "SaaS Facturation" },
  { id: 2, name: "Architecte Sophia", role: "Architecte", model: "Claude Sonnet 4.6", status: "planning", mission: "Refactoring API Gateway", context: "89k / 200k", cost: "€12.40", successRate: 94, project: "SaaS Facturation" },
  { id: 3, name: "Frontend Leo", role: "Lead Frontend", model: "GPT-4o", status: "execution", mission: "Dashboard composants", context: "64k / 128k", cost: "€8.90", successRate: 91, project: "App Mobile Sport" },
  { id: 4, name: "Backend Mira", role: "Lead Backend", model: "Claude Sonnet 4.6", status: "validation", mission: "Endpoints paiements", context: "112k / 200k", cost: "€18.70", successRate: 96, project: "Plateforme Réservation" },
  { id: 5, name: "SecOps Rex", role: "Cybersécurité", model: "DeepSeek R1", status: "blocked", mission: "Audit authentification", context: "78k / 128k", cost: "€6.20", successRate: 88, project: "API Finance" },
  { id: 6, name: "QA Nova", role: "QA / Review", model: "Claude Sonnet 4.6", status: "execution", mission: "Tests end-to-end", context: "95k / 200k", cost: "€15.80", successRate: 98, project: "Plateforme Réservation" },
  { id: 7, name: "Infra Atlas", role: "Infrastructure", model: "GPT-4o", status: "available", mission: "—", context: "0 / 128k", cost: "€0", successRate: 93, project: "—" },
];

export const KANBAN: Record<string, { id: string; title: string; team: string; agent: string; priority: string; duration: string; branch: string; tests?: string }[]> = {
  "À planifier": [
    { id: "T-091", title: "Intégration Stripe webhooks", team: "Backend", agent: "Backend Mira", priority: "haute", duration: "2h", branch: "feature/stripe-hooks" },
    { id: "T-092", title: "Cache Redis sessions utilisateur", team: "Backend", agent: "—", priority: "normale", duration: "3h", branch: "—" },
  ],
  "Prête": [
    { id: "T-087", title: "Page tableau de bord client", team: "Frontend", agent: "Frontend Leo", priority: "haute", duration: "4h", branch: "feat/dashboard-client" },
  ],
  "En cours": [
    { id: "T-083", title: "API REST facturation v2", team: "Backend", agent: "Backend Mira", priority: "critique", duration: "6h", branch: "api/billing-v2", tests: "passing" },
    { id: "T-085", title: "Composants design system", team: "Frontend", agent: "Frontend Leo", priority: "haute", duration: "3h", branch: "ui/components-v2", tests: "running" },
    { id: "T-088", title: "Migration base de données v3", team: "Backend", agent: "Architecte Sophia", priority: "critique", duration: "8h", branch: "db/migration-v3", tests: "pending" },
  ],
  "En validation": [
    { id: "T-079", title: "Authentification OAuth Google", team: "Backend", agent: "SecOps Rex", priority: "haute", duration: "5h", branch: "auth/oauth-google", tests: "passing" },
  ],
  "PR ouverte": [
    { id: "T-074", title: "Refactoring module paiements", team: "Backend", agent: "Backend Mira", priority: "normale", duration: "4h", branch: "refactor/payments", tests: "passing" },
    { id: "T-076", title: "Tests unitaires controllers", team: "QA", agent: "QA Nova", priority: "haute", duration: "3h", branch: "test/controllers", tests: "passing" },
  ],
  "Bloquée": [
    { id: "T-071", title: "Connexion bancaire open banking", team: "Backend", agent: "SecOps Rex", priority: "critique", duration: "—", branch: "feat/open-banking", tests: "failed" },
  ],
  "Terminée": [
    { id: "T-068", title: "Architecture microservices", team: "Architecture", agent: "Architecte Sophia", priority: "haute", duration: "12h", branch: "arch/microservices", tests: "passing" },
    { id: "T-069", title: "Setup CI/CD GitHub Actions", team: "Infra", agent: "Infra Atlas", priority: "haute", duration: "4h", branch: "ci/github-actions", tests: "passing" },
  ],
};

export const INTERVENTIONS = [
  {
    id: 1, project: "API Finance",
    question: "Faut-il implémenter l'authentification via OAuth 2.0 ou SAML pour les partenaires bancaires ?",
    reason: "Deux standards sont compatibles mais SAML offre plus de contrôle pour les grandes institutions financières.",
    impact: "Affecte l'architecture d'authentification et 3 missions dépendantes. Délai estimé : 2 jours supplémentaires.",
    options: ["OAuth 2.0 avec PKCE", "SAML 2.0 avec SSO", "Les deux en parallèle"],
    recommendation: "OAuth 2.0 avec PKCE",
    urgency: "haute", blockedAgents: ["SecOps Rex", "Backend Mira"], time: "il y a 23 min", type: "choix-architecture",
  },
  {
    id: 2, project: "Plateforme Réservation",
    question: "Le déploiement en production est prêt. Confirmez-vous la mise en ligne ?",
    reason: "Tous les tests passent (98% coverage). Dernière PR fusionnée il y a 1h. Aucun incident détecté.",
    impact: "Mise en production immédiate ou progressive. Rollback disponible en 30 secondes si besoin.",
    options: ["Déployer maintenant", "Reporter à demain matin", "Déploiement progressif 10%"],
    recommendation: "Déploiement progressif 10%",
    urgency: "normale", blockedAgents: ["Infra Atlas"], time: "il y a 1h", type: "deploiement",
  },
  {
    id: 3, project: "SaaS Facturation",
    question: "Le budget mensuel alloué est atteint à 87 %. Augmenter ou ralentir les agents ?",
    reason: "Consommation plus élevée que prévu, due à des itérations complexes sur le module comptabilité.",
    impact: "Sans action, arrêt automatique des agents dans environ 4 jours.",
    options: ["Augmenter de €200", "Ralentir les agents non critiques", "Pause temporaire"],
    recommendation: "Ralentir les agents non critiques",
    urgency: "normale", blockedAgents: [], time: "il y a 3h", type: "budget",
  },
];

export const PROVIDERS = [
  { name: "Anthropic / Claude", models: ["claude-opus-4-8", "claude-sonnet-4-6"], status: "healthy", latency: "1.2s", rateLimit: 72, tokens: "2.4M", cost: "€89.40", missions: 6, health: 99 },
  { name: "OpenAI / GPT-4o", models: ["gpt-4o", "gpt-4o-mini", "o3"], status: "healthy", latency: "0.9s", rateLimit: 34, tokens: "1.1M", cost: "€34.20", missions: 3, health: 98 },
  { name: "DeepSeek", models: ["deepseek-r1", "deepseek-v3"], status: "warning", latency: "3.8s", rateLimit: 91, tokens: "0.8M", cost: "€12.60", missions: 1, health: 72 },
  { name: "Cursor CLI", models: ["cursor-fast", "cursor-slow"], status: "healthy", latency: "0.6s", rateLimit: 22, tokens: "0.3M", cost: "€8.90", missions: 2, health: 96 },
];

export const CONSUMPTION = [
  { day: "Lun", cost: 12.4, tokens: 340 },
  { day: "Mar", cost: 21.8, tokens: 580 },
  { day: "Mer", cost: 15.2, tokens: 420 },
  { day: "Jeu", cost: 25.1, tokens: 690 },
  { day: "Ven", cost: 18.7, tokens: 510 },
  { day: "Sam", cost: 9.8, tokens: 280 },
  { day: "Dim", cost: 6.9, tokens: 190 },
];

export const ACTIVITY_LOG = [
  { time: "14:32", project: "SaaS Facturation", agent: "Backend Mira", event: "Commit poussé", action: "git push origin api/billing-v2", result: "success", cost: "—" },
  { time: "14:28", project: "Plateforme Réservation", agent: "QA Nova", event: "Tests terminés", action: "npm run test:e2e", result: "success", cost: "€0.40" },
  { time: "14:15", project: "API Finance", agent: "SecOps Rex", event: "Mission bloquée", action: "Attente décision auth", result: "blocked", cost: "—" },
  { time: "13:58", project: "App Mobile Sport", agent: "Frontend Leo", event: "PR ouverte", action: "Composants navigation iOS", result: "success", cost: "€1.20" },
  { time: "13:44", project: "SaaS Facturation", agent: "Architecte Sophia", event: "ADR créé", action: "ADR-007 : API Gateway pattern", result: "success", cost: "€0.80" },
  { time: "13:30", project: "Plateforme Réservation", agent: "Cerveau Central", event: "Plan révisé", action: "Sprint #8 planifié (14 missions)", result: "success", cost: "€2.10" },
  { time: "13:12", project: "API Finance", agent: "Backend Mira", event: "Erreur détectée", action: "Migration DB : contrainte violée", result: "error", cost: "€0.30" },
  { time: "12:55", project: "App Mobile Sport", agent: "Cerveau Central", event: "Checkpoint validé", action: "Phase 1 terminée — Maquettes approuvées", result: "success", cost: "€4.20" },
];

export const PRS = [
  { id: "PR #47", title: "feat(billing): Stripe webhooks et gestion des abonnements récurrents", agent: "Backend Mira", reviewer: "QA Nova", branch: "api/billing-v2 → main", files: 7, risk: "faible", tests: "passing", status: "review", mission: "T-083" },
  { id: "PR #46", title: "refactor(payments): Extraction module paiements en service autonome", agent: "Backend Mira", reviewer: "Architecte Sophia", branch: "refactor/payments → main", files: 12, risk: "moyenne", tests: "passing", status: "approved", mission: "T-074" },
  { id: "PR #45", title: "test: Ajout tests unitaires pour les controllers REST (coverage +12%)", agent: "QA Nova", reviewer: "SecOps Rex", branch: "test/controllers → main", files: 4, risk: "faible", tests: "passing", status: "merged", mission: "T-076" },
];

export const DIFF = [
  { t: "meta", c: "diff --git a/src/billing/stripe.ts b/src/billing/stripe.ts" },
  { t: "meta", c: "--- a/src/billing/stripe.ts  +++ b/src/billing/stripe.ts" },
  { t: "ctx", c: " import Stripe from 'stripe';" },
  { t: "ctx", c: " " },
  { t: "ctx", c: " export class StripeService {" },
  { t: "ctx", c: "   constructor(private config: StripeConfig) {}" },
  { t: "add", c: "+  async handleWebhook(payload: Buffer, sig: string) {" },
  { t: "add", c: "+    const event = stripe.webhooks.constructEvent(payload, sig, this.config.secret);" },
  { t: "add", c: "+    switch (event.type) {" },
  { t: "add", c: "+      case 'invoice.paid': return this.onInvoicePaid(event.data.object);" },
  { t: "add", c: "+      case 'subscription.updated': return this.onSubscriptionUpdate(event.data.object);" },
  { t: "add", c: "+      default: break;" },
  { t: "add", c: "+    }" },
  { t: "add", c: "+  }" },
  { t: "del", c: "-  async processPayment(amount: number) {" },
  { t: "del", c: "-    // TODO: implement" },
  { t: "del", c: "-  }" },
  { t: "ctx", c: " }" },
];

export const TERM_OUT = [
  "> npm run build:api",
  "Building production bundle...",
  "✓ Routes compiled (48 endpoints)",
  "✓ Middleware stack validated",
  "✓ Database migrations checked",
  "✓ OpenAPI spec generated (v3.1)",
  "Build successful in 4.2s",
  "",
  "> git add -A && git commit -m 'feat(billing): implement Stripe webhooks v2'",
  "[api/billing-v2 c4f7a91] feat(billing): implement Stripe webhooks v2",
  " 7 files changed, 312 insertions(+), 48 deletions(-)",
  "",
  "> npm run test -- --testPathPattern=billing",
  "PASS  src/billing/stripe.test.ts (12 tests)",
  "PASS  src/billing/invoices.test.ts (8 tests)",
  "All tests passed in 3.1s",
];


export type Project = (typeof PROJECTS)[number];
export type Agent = (typeof AGENTS)[number];
export type Intervention = (typeof INTERVENTIONS)[number];
export type KanbanCard = (typeof KANBAN)[string][number];
export type ProviderCard = (typeof PROVIDERS)[number];
export type ActivityRow = (typeof ACTIVITY_LOG)[number];
export type PrCard = (typeof PRS)[number];
