# Screenshot notes

Captured on **October 1, 2026** from the running app at `http://127.0.0.1:3213/`.

| Image | Product state |
| --- | --- |
| `product-overview.jpg` | Expanded Operations → Supply Chain topics in the readable tree list/branch interface. |
| `node-detail.jpg` | Procurement summary and child topics. |
| `document-intake.jpg` | Upload interface before any document was ingested. |

The existing `src/kg/seedMultilevelTree.js` script created **20 fictional ACME demo nodes** in the isolated, ignored `data/readme-demo` directory. The regular datasets were not used. Environment credentials were suppressed and embeddings were disabled.

These are actual browser captures, not generated mockups. No document ingestion, model inference, vector retrieval, or generated answer was performed. Manually authored topic summaries do not establish extracted knowledge, retrieval accuracy, or provider readiness.

The capture used the local `arborkb-v4` development working tree. Some uncommitted implementation changes are excluded from the documentation publication. The published GitHub checkout may therefore differ; the branch name does not establish that all illustrated development code has been published.
