# Live E2E External Fixture Spec

## Objectif

La commande `avity e2e fixture create --path <path> [--remote <url>] [--json]` genere un depot Git local autonome pour campagne live, sans provider reel, sans secret, sans publication automatique et sans push implicite.

## Contraintes de securite et exploitation

- Le depot est initialise localement sur `main` avec un commit initial.
- Les hooks Git et la signature GPG sont neutralises localement pour garantir un comportement deterministe en environnement CI/dev.
- Le remote est optionnel et accepte uniquement des URLs GitHub valides (`https://github.com/...` ou `git@github.com:...` / `ssh://git@github.com/...`).
- Aucun appel reseau n'est declenche pendant la generation.
- Creation transactionnelle: si une etape post-creation echoue (ecriture, git init/add/commit, remote add), le repertoire cree par l'invocation est supprime.
- Un repertoire preexistant n'est jamais supprime.
- `--path` n'est pas limite au workspace AvityOS: la destination externe est librement choisie par l'operateur.

## Contenu genere

- `src/index.ts`: objectifs deterministes pour mission normale et mission rejet/correction.
- `src/solution.js`: implementation de reference soumise au check d'acceptation metier.
- `test/objectives.test.js`: validation runtime des objectifs.
- `scripts/lint.mjs`: lint syntaxique natif (`node --check`) sans dependance externe.
- `scripts/acceptance.mjs`: check metier deterministe pour rejet/correction.
- `package.json`: scripts `test`, `lint`, `acceptance`, et `typecheck` (alias honnete de lint), sans script de publication.
- `README.md`: procedure d'usage et objectifs des deux missions.

## UX CLI

- Compatibilite maintenue avec `avity e2e preflight`.
- Sortie humaine: chemin du depot, branche, remote configure ou absent.
- Sortie JSON (`--json`): objet machine-readable avec `path`, `branch`, `remote`.

## Refus idempotent

Si le chemin cible existe deja, la commande echoue explicitement sans ecraser le contenu.
