import { initDb, runTransaction } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";

initDb();

const hasRoot = NodeRepo.existsById("root");

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

try {
  const result = runTransaction(() => {
    let inserted = 0;
    let updated = 0;

    for (const n of demoNodes) {
      let level = 1;
      if (!n.parent_id) {
        level = 0;
      } else {
        const parentLevel = NodeRepo.getLevel(n.parent_id);
        if (parentLevel === null) {
          throw new Error(`Parent node not found: ${n.parent_id} for node ${n.node_id}`);
        }
        level = (Number(parentLevel) || 0) + 1;
      }

      const existing = NodeRepo.existsById(n.node_id);
      NodeRepo.upsert({ node_id: n.node_id, name: n.name, parent_id: n.parent_id, level, summary: n.summary });
      if (existing) {
        updated += 1;
      } else {
        inserted += 1;
      }

      NodeRepo.deleteFtsForNode(n.node_id);
      NodeRepo.insertFtsText(n.node_id, `${n.name} ${n.summary}`);
    }

    return { inserted, updated };
  });

  const totalDemo = NodeRepo.countByPrefix("demo.");

  console.log(
    `Seeded multilevel demo tree. Inserted: ${result.inserted}, Updated: ${result.updated}, Demo nodes total: ${totalDemo}`
  );
} catch (err) {
  console.error("Failed to seed multilevel demo tree:", err.message);
  process.exit(1);
}
