// Loads ANTHROPIC_API_KEY (and optional MIRAGE_TEST_MODEL) from a local .env
// if present. Variables already exported in the shell take precedence.
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'

config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })
