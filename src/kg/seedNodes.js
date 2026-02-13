import { db, initDb } from "../db/db.js";

initDb();

const nodes = [
  { node_id: "sales", name: "销售", parent_id: null, level: 1, summary: "销售相关总览" },
  { node_id: "sales.process", name: "销售流程", parent_id: "sales", level: 2, summary: "销售流程与步骤" },
  { node_id: "sales.rules", name: "销售规则", parent_id: "sales", level: 2, summary: "销售相关规则与约束" },
  { node_id: "product", name: "产品", parent_id: null, level: 1, summary: "产品知识总览" },
  { node_id: "product.pricing", name: "定价", parent_id: "product", level: 2, summary: "产品价格、折扣、报价规则" },
];

const insertNode = db.prepare(`
  INSERT OR REPLACE INTO nodes(node_id,name,parent_id,level,node_summary,updated_at)
  VALUES (@node_id,@name,@parent_id,@level,@summary,datetime('now'))
`);
const insertFts = db.prepare(`
  INSERT INTO nodes_fts(node_id,text) VALUES (?,?)
`);

db.prepare("DELETE FROM nodes_fts").run();

for (const n of nodes) {
  insertNode.run(n);
  const text = `${n.name} ${n.summary}`;
  insertFts.run(n.node_id, text);
}

console.log("Seeded nodes.");
