import { initDb } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";

initDb();

const nodes = [
  { node_id: "sales", name: "销售", parent_id: null, level: 1, summary: "销售相关总览" },
  { node_id: "sales.process", name: "销售流程", parent_id: "sales", level: 2, summary: "销售流程与步骤" },
  { node_id: "sales.rules", name: "销售规则", parent_id: "sales", level: 2, summary: "销售相关规则与约束" },
  { node_id: "product", name: "产品", parent_id: null, level: 1, summary: "产品知识总览" },
  { node_id: "product.pricing", name: "定价", parent_id: "product", level: 2, summary: "产品价格、折扣、报价规则" },
];

NodeRepo.clearFts();

for (const n of nodes) {
  NodeRepo.upsert(n);
  NodeRepo.insertFtsText(n.node_id, `${n.name} ${n.summary}`);
}

console.log("Seeded nodes.");
