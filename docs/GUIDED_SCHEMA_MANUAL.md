# TreeKB — Guided Dataset Structure: User Manual

---

## What This Feature Does

By default, TreeKB grows the knowledge tree organically: when you ingest a document, the LLM invents topic names and creates nodes as it sees fit. The result is useful but unpredictable — different documents may create overlapping or inconsistently-named nodes.

The **Guided Tree Schema** feature lets you pre-define the tree skeleton first. Once you define a schema and switch to Guided mode, every document you ingest maps its content into *your* structure instead of inventing its own.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Schema node** | A node you defined as part of the intended structure (shown with 📌) |
| **Free mode** | Default — LLM invents topic names per document |
| **Guided mode** | KPs are mapped to your schema nodes; unmatched topics become child nodes (soft) or are clamped (hard) |
| **Soft strictness** | Unmatched topics create child nodes *under* the closest schema ancestor |
| **Hard strictness** | Unmatched topics are clamped to the closest schema ancestor — no new nodes created |
| **Template** | A saved schema you can apply to any dataset from a shared library |

---

## Workflow Overview

```
1. Design your tree on paper
2. Import it as JSON  ──or──  create nodes manually in the Tree tab
3. Review schema nodes in the Schema panel
4. Switch to Guided mode  (+ choose strictness)
5. Upload documents
6. Review the resulting tree
7. (Optional) Save schema as a global template
```

---

## Step 1 — Design Your Tree

Think about the major topic areas your documents cover. A good schema is:

- **Shallow** — 2–3 levels max. Deeper trees confuse the mapper.
- **Mutually exclusive** — each topic should have a clear home, not overlap with siblings.
- **Broad enough** — you don't need a node for every sub-topic; let Soft mode create children.

**Example — HR Knowledge Base:**
```
HR Policies
  ├── Leave & Attendance
  ├── Compensation & Benefits
  └── Code of Conduct
IT Procedures
  ├── Access Management
  └── Incident Response
SLA Commitments
  ├── Response Times
  └── Escalation Rules
```

---

## Step 2 — Define the Schema

You have two options:

### Option A — Import JSON (fastest)

Create a `.json` file. The format is a nested array:

```json
[
  {
    "name": "HR Policies",
    "description": "Employment terms, leave, compensation, conduct",
    "children": [
      { "name": "Leave & Attendance", "description": "Annual leave, sick leave, attendance rules" },
      { "name": "Compensation & Benefits", "description": "Salary, bonuses, insurance, retirement" },
      { "name": "Code of Conduct", "description": "Ethics, disciplinary procedures, grievances" }
    ]
  },
  {
    "name": "IT Procedures",
    "description": "Technology policies and support procedures",
    "children": [
      { "name": "Access Management", "description": "User accounts, permissions, VPN" },
      { "name": "Incident Response", "description": "Outage response, ticket priorities, escalation" }
    ]
  },
  {
    "name": "SLA Commitments",
    "description": "Service level agreements and response targets",
    "children": [
      { "name": "Response Times", "description": "P1/P2/P3 response and resolution targets" },
      { "name": "Escalation Rules", "description": "When and how to escalate incidents" }
    ]
  }
]
```

**Importing:**
1. Go to the **Tree** tab
2. In the **Schema** panel at the top, click **Import JSON**
3. Select your `.json` file
4. Choose **Merge** (adds schema flags to any existing nodes with matching names) or **Replace** (clears all schema flags first)

> **Tip:** The `description` field is optional but important — it helps the mapper match KPs whose topic hints don't exactly match the node name.

### Option B — Use the Tree UI

1. Go to the **Tree** tab
2. Click **+ Add Node** and create your nodes normally
3. The Schema panel will pick them up once you flag them (currently done via import or apply-template)

> For initial setup, JSON import is faster. Use the UI to add nodes *after* the skeleton is in place.

---

## Step 3 — Review the Schema Panel

After importing, open the **Schema** panel (click the header bar to expand it). You'll see:

- **Schema Nodes** — a tree view of all nodes marked as schema nodes
- **Keywords** — shown as chips; these accumulate automatically as documents are ingested
- **Global Templates** — saved schemas you or your team share

If a node should be part of the schema but isn't listed, re-import with Merge mode.

---

## Step 4 — Switch to Guided Mode

1. Click the **Settings** button in the Schema panel (or click the mode badge next to the tree title)
2. Select **Guided** under Mapping Mode
3. Choose strictness:
   - **Soft** — recommended for most cases. Topics the mapper can't confidently assign become child nodes under the nearest schema ancestor. Your tree grows deliberately but isn't rigid.
   - **Hard** — for tightly-controlled datasets. Every KP is forced into an existing schema node. No new nodes are ever created during ingest.
4. Choose **Tree Routing** mode (affects query-time retrieval, not ingestion):
   - **Keyword** (default) — the tree beam search uses BM25 keyword scoring to navigate nodes. Fast and cost-free.
   - **LLM** — the beam search sends candidate nodes to the LLM for semantic relevance scoring. This bridges vocabulary gaps (e.g., a query about "vacation days" can find a node named "Leave & Attendance" even with no keyword overlap). Costs additional LLM calls per query. Scores are blended: `max(LLM score, keyword score)`, so strong keyword hits are never suppressed.
5. Click **Save**

The mode badge in the tree header will update to show the current mode (e.g. `Guided (soft)`).

---

## Step 5 — Ingest Documents

Upload documents normally via the **Upload** tab. The pipeline now:

1. Extracts KPs from the document
2. For each KP's topic hint, scores it against every schema node using name similarity + description similarity + keyword overlap
3. If the best score ≥ 0.30, assigns the KP to that schema node
4. For lower-scoring topics, asks the LLM in a single batched call whether any schema node matches
5. Remaining unmatched topics are handled by the strictness setting

You don't need to change anything in the upload form — just upload as normal.

---

## Step 6 — Review the Results

After ingest:

- Open the **Tree** tab and browse your schema nodes
- Click any node to see its knowledge points, description, and accumulated keywords
- Schema nodes show a 📌 badge in the node detail panel
- The **Keywords** section shows terms extracted from ingested KPs — these improve future BM25 retrieval

**Signs the mapping worked well:**
- KPs land in the expected schema nodes
- Few or no stray top-level nodes created (in soft mode)
- Keywords on each schema node reflect the right domain vocabulary

**Signs to adjust:**
- KPs land in the wrong node → improve the `description` fields in your schema and re-import
- Too many child nodes created in soft mode → consider switching to Hard, or tighten the schema descriptions
- All KPs pile into one node → schema nodes may be too similar; add more distinctive descriptions

---

## Step 7 — Save as a Global Template (Optional)

If you've built a schema that other datasets should reuse:

1. Open the Schema panel
2. Click **Save as Template**
3. Give it a name (e.g. "Standard HR Knowledge Base")
4. Click **Save**

The template is stored globally and available across all datasets.

**To apply a template to a new dataset:**
1. Create the dataset and switch to it
2. Go to Tree tab → Schema panel → Templates section
3. Click **Apply** next to the template
4. The schema nodes are imported and the dataset is automatically switched to Guided mode

---

## JSON Schema Format Reference

```json
[
  {
    "id": "optional-custom-slug",        // if omitted, auto-generated from name
    "name": "Required: Node Name",       // displayed in the tree
    "description": "Optional help text", // used by the mapper for scoring
    "children": [                        // nested nodes, any depth
      {
        "name": "Child Node",
        "description": "...",
        "children": []
      }
    ]
  }
]
```

When **exporting**, the JSON follows the same structure. You can export, edit in a text editor, and re-import.

---

## Choosing Strictness: Quick Guide

| Situation | Recommended |
|-----------|-------------|
| First ingest of a new domain | Soft — discover what topics naturally emerge |
| Well-understood domain, clean docs | Hard — maximum structure |
| Regulatory / compliance content | Hard — no stray nodes allowed |
| Research / exploratory knowledge base | Soft — allow the tree to grow organically within the schema |
| Mixed-domain document sets | Soft — handles edge cases gracefully |

---

## Troubleshooting

**Q: KPs are mapping to the wrong schema node.**
Add or improve the `description` field on the target node. The mapper scores description similarity at 30% weight. Also check if the node's keywords are populated — more keywords = better matching.

**Q: The mapper always falls back to root.**
No schema nodes are defined, or `mapping_mode` is still `free`. Check the mode badge and the Schema panel's node list.

**Q: In hard mode, everything goes to one node.**
The mapper finds the closest schema node for every topic — if your schema only has one node that's vaguely relevant, everything will land there. Add more schema nodes, or switch to Soft.

**Q: I imported JSON but no schema nodes appear.**
Check that your JSON is a valid array at the top level. If it's an object with a `nodes` or `tree` key, the importer handles that too, but double-check the structure.

**Q: Can I switch back to Free mode?**
Yes — open Schema Settings and select **Free**. All schema node flags remain in the database; they're simply not used until you switch back to Guided.

**Q: Do existing ingested documents get re-mapped?**
No. Mode and strictness only affect new ingestion jobs. Existing KPs stay in their current nodes.

**Q: When should I enable LLM tree routing?**
Enable it when queries frequently fail to find the right node due to vocabulary mismatch — for example, if your schema uses formal terms ("Compensation & Benefits") but users ask with informal phrasing ("how much do I get paid"). LLM routing adds latency and cost (one LLM call per beam search level, batched at 40 nodes), so leave it on Keyword mode if keyword matching is working well. LLM routing results are cached (200 entries) to reduce repeat costs.

**Q: Does tree routing mode affect ingestion?**
No. Tree routing mode only affects query-time retrieval (the `/ask` pipeline). Ingestion mapping uses its own scoring logic based on the Mapping Mode and Strictness settings.
