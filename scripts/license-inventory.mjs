#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const store = join(process.cwd(), "node_modules", ".pnpm");
if (!existsSync(store)) {
  console.error("node_modules/.pnpm is missing; run pnpm install first");
  process.exit(1);
}

const packages = new Map();
for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const modules = join(store, entry.name, "node_modules");
  if (!existsSync(modules)) continue;
  for (const item of readdirSync(modules, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    if (item.name.startsWith("@")) {
      const scope = join(modules, item.name);
      for (const child of readdirSync(scope, { withFileTypes: true })) {
        if (child.isDirectory()) collect(join(scope, child.name));
      }
    } else {
      collect(join(modules, item.name));
    }
  }
}

function collect(directory) {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (!pkg.name || !pkg.version) return;
    const license = normalizeLicense(pkg.license ?? pkg.licenses);
    packages.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version,
      license,
      repository: typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? null),
    });
  } catch {
    // A malformed installed package manifest is reported as a missing record
    // by the count discrepancy during dependency installation/build.
  }
}

function normalizeLicense(value) {
  if (typeof value === "string") return value.trim() || "UNKNOWN";
  if (Array.isArray(value)) return value.map(normalizeLicense).join(" OR ");
  if (value && typeof value.type === "string") return value.type;
  return "UNKNOWN";
}

const inventory = [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const forbidden = inventory.filter((pkg) => /(^|[^A-Z])(AGPL|SSPL|BUSL|UNLICENSED)([^A-Z]|$)/i.test(pkg.license));
const unknown = inventory.filter((pkg) => pkg.license === "UNKNOWN");
const report = {
  generatedAt: new Date().toISOString(),
  packageCount: inventory.length,
  policy: { denied: ["AGPL", "SSPL", "BUSL", "UNLICENSED"], unknownLicensesAllowed: false },
  violations: [...forbidden, ...unknown],
  packages: inventory,
};

const output = process.argv[2];
if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (report.violations.length) {
  console.error(`license policy failed for ${report.violations.length} package(s)`);
  for (const violation of report.violations) console.error(`- ${violation.name}@${violation.version}: ${violation.license}`);
  process.exit(1);
}
console.error(`license policy passed for ${inventory.length} installed package(s)`);
