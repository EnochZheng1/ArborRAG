import { db, initDb } from "../db/db.js";

initDb();

const hasRoot = Boolean(
  db.prepare("SELECT 1 FROM nodes WHERE node_id = ?").get("root")
);

const parentForDemoRoot = hasRoot ? "root" : null;

// Parent-first ordering so level can be computed from existing/inserted parent rows.
const demoNodes = [
  {
    node_id: "demo.acme",
    name: "ACME Global (Demo)",
    parent_id: parentForDemoRoot,
    summary: "Top-level demo organization for multilevel tree visualization."
  },
  {
    node_id: "demo.acme.operations",
    name: "Operations",
    parent_id: "demo.acme",
    summary: "Operational planning, delivery, and quality management."
  },
  {
    node_id: "demo.acme.operations.supply",
    name: "Supply Chain",
    parent_id: "demo.acme.operations",
    summary: "Procurement, inventory, and logistics workflows."
  },
  {
    node_id: "demo.acme.operations.supply.procurement",
    name: "Procurement",
    parent_id: "demo.acme.operations.supply",
    summary: "Vendor sourcing, onboarding, and purchase approvals."
  },
  {
    node_id: "demo.acme.operations.supply.procurement.vendor-onboarding",
    name: "Vendor Onboarding",
    parent_id: "demo.acme.operations.supply.procurement",
    summary: "Checklist and controls for approving new vendors."
  },
  {
    node_id: "demo.acme.operations.supply.inventory",
    name: "Inventory Planning",
    parent_id: "demo.acme.operations.supply",
    summary: "Safety stock, reorder points, and demand balancing."
  },
  {
    node_id: "demo.acme.operations.quality",
    name: "Quality Management",
    parent_id: "demo.acme.operations",
    summary: "Inspections, audits, and corrective action processes."
  },
  {
    node_id: "demo.acme.sales",
    name: "Sales",
    parent_id: "demo.acme",
    summary: "Revenue org structure, pipeline, and deal lifecycle."
  },
  {
    node_id: "demo.acme.sales.enterprise",
    name: "Enterprise Sales",
    parent_id: "demo.acme.sales",
    summary: "Large account strategy and complex deal management."
  },
  {
    node_id: "demo.acme.sales.enterprise.discovery",
    name: "Discovery",
    parent_id: "demo.acme.sales.enterprise",
    summary: "Needs analysis, qualification, and stakeholder mapping."
  },
  {
    node_id: "demo.acme.sales.channels",
    name: "Channel Partners",
    parent_id: "demo.acme.sales",
    summary: "Distributor and reseller partner governance."
  },
  {
    node_id: "demo.acme.product",
    name: "Product & Engineering",
    parent_id: "demo.acme",
    summary: "Roadmap, architecture, and release management."
  },
  {
    node_id: "demo.acme.product.platform",
    name: "Platform",
    parent_id: "demo.acme.product",
    summary: "Core platform services and architecture standards."
  },
  {
    node_id: "demo.acme.product.platform.api",
    name: "API Services",
    parent_id: "demo.acme.product.platform",
    summary: "Public/private API lifecycle and contract standards."
  },
  {
    node_id: "demo.acme.product.platform.api.versioning",
    name: "API Versioning Policy",
    parent_id: "demo.acme.product.platform.api",
    summary: "Backward compatibility and deprecation rules."
  },
  {
    node_id: "demo.acme.product.platform.ui",
    name: "UI Platform",
    parent_id: "demo.acme.product.platform",
    summary: "Design system, accessibility, and frontend standards."
  },
  {
    node_id: "demo.acme.product.enablement",
    name: "Product Enablement",
    parent_id: "demo.acme.product",
    summary: "Documentation, training content, and launch readiness."
  },
  {
    node_id: "demo.acme.finance",
    name: "Finance",
    parent_id: "demo.acme",
    summary: "Planning, reporting, and risk controls."
  },
  {
    node_id: "demo.acme.finance.planning",
    name: "Financial Planning",
    parent_id: "demo.acme.finance",
    summary: "Budgeting, forecasts, and scenario planning."
  },
  {
    node_id: "demo.acme.finance.planning.capex",
    name: "CapEx Governance",
    parent_id: "demo.acme.finance.planning",
    summary: "Capital spending approval and compliance checks."
  }
];

const upsertNode = db.prepare(`
  INSERT INTO nodes (node_id, name, parent_id, level, node_summary, updated_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(node_id) DO UPDATE SET
    name = excluded.name,
    parent_id = excluded.parent_id,
    level = excluded.level,
    node_summary = excluded.node_summary,
    updated_at = datetime('now')
`);

const insertFts = db.prepare(`
  INSERT INTO nodes_fts (node_id, text)
  VALUES (?, ?)
`);

const deleteFtsForNode = db.prepare("DELETE FROM nodes_fts WHERE node_id = ?");
const getNodeLevel = db.prepare("SELECT level FROM nodes WHERE node_id = ?");
const getExistingNode = db.prepare("SELECT node_id FROM nodes WHERE node_id = ?");

const seedTransaction = db.transaction((nodes) => {
  let inserted = 0;
  let updated = 0;

  for (const n of nodes) {
    let level = 1;
    if (!n.parent_id) {
      level = 0;
    } else {
      const parent = getNodeLevel.get(n.parent_id);
      if (!parent) {
        throw new Error(`Parent node not found: ${n.parent_id} for node ${n.node_id}`);
      }
      level = (Number(parent.level) || 0) + 1;
    }

    const existing = getExistingNode.get(n.node_id);
    upsertNode.run(n.node_id, n.name, n.parent_id, level, n.summary);
    if (existing) {
      updated += 1;
    } else {
      inserted += 1;
    }

    deleteFtsForNode.run(n.node_id);
    insertFts.run(n.node_id, `${n.name} ${n.summary}`);
  }

  return { inserted, updated };
});

try {
  const result = seedTransaction(demoNodes);
  const totalDemo = db
    .prepare("SELECT COUNT(*) as count FROM nodes WHERE node_id LIKE 'demo.%'")
    .get().count;

  console.log(
    `Seeded multilevel demo tree. Inserted: ${result.inserted}, Updated: ${result.updated}, Demo nodes total: ${totalDemo}`
  );
} catch (err) {
  console.error("Failed to seed multilevel demo tree:", err.message);
  process.exit(1);
}
