// Side-effect module, imported FIRST by the runner. `src/lib/env.ts` validates
// process.env at import time, so .env has to be loaded before anything pulls
// it in — ESM evaluates imports in source order, which makes this reliable.
import { config } from 'dotenv'

config({ path: '.env', quiet: true })
