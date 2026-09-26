import type { AiRole } from '@/lib/ai-settings'

/**
 * How each job is named and explained in Settings (spec 0040 FR2, spec 0042
 * FR2). `help` is the line under the name; `details` is what the ⓘ says.
 */
export const ROLE_LABELS: Record<
  AiRole,
  { label: string; help: string; details: string[] }
> = {
  chat: {
    label: 'Chat',
    help: 'Writes the answers, from the passages retrieval found.',
    details: [
      'This is the model that writes the answer you read. It gets your question and the passages the search found, and it is told to answer only from those.',
      'Bigger models write better answers but take longer to start replying. If answers feel slow, try a smaller or faster model here first.',
    ],
  },
  planner: {
    label: 'Planner',
    help: 'Decides what to search in agentic mode, and scores passages for the LLM reranker. Needs tool calls.',
    details: [
      'Used when agentic mode is on. Before anything is written, the planner reads the question and decides what to search for, and whether one search was enough or it should look again with different words.',
      'It works by calling tools, so the model has to support tool calls; Test checks that. It can run two or three times for one question, so a quick model keeps answers snappy.',
      'When the reranker is set to use a model, this is the model that scores the passages too.',
    ],
  },
  hyde: {
    label: 'HyDE',
    help: 'Drafts a hypothetical passage to search with, when HyDE is on.',
    details: [
      'HyDE means Hypothetical Document Embeddings. With it on, this model first writes a short, made-up passage that looks like what an answer might say, and the app searches with that instead of the question as typed.',
      'It helps when people ask things in very different words from the documents. It costs one extra model call per question, and it only runs when HyDE is switched on.',
    ],
  },
  vision: {
    label: 'Vision',
    help: 'Describes figures and reads charts, when cracking or read-figure is on.',
    details: [
      'This model reads pictures. While PDFs are processed it describes charts and figures, so what they show becomes searchable text. During a chat it can look at a figure to read a value off it.',
      'It must be a model that accepts images. It only runs when PDF cracking or read-figure is switched on.',
    ],
  },
  parse: {
    label: 'Page parser',
    help: 'Reads page layout from page images when PDFs are cracked.',
    details: [
      'Works out the layout of a page from a picture of it: headings, paragraphs, tables and figures. That is how scanned or complicated PDFs get split into sensible passages.',
      'It only runs while documents are being processed with cracking on, never during a chat.',
    ],
  },
  embed: {
    label: 'Embeddings',
    help: 'Turns passages and questions into vectors. Changing it re-indexes every document first.',
    details: [
      'Turns every passage, and every question, into a list of numbers that captures its meaning. Search compares those numbers, which is how it finds passages that mean the same as the question even when the words differ.',
      'Your whole index was built with this model, and numbers from two different models cannot be compared. So saving a new one starts re-indexing: every passage is embedded again, search stays on the current model until that finishes, then switches over in one step.',
      'The model must return at most 4000 numbers per passage. It stays on the .env connection for now.',
    ],
  },
}

/** What the ⓘ next to each field says. */
export const FIELD_HELP = {
  providers: {
    title: 'Providers',
    details: [
      'A provider is a server that runs AI models and speaks the OpenAI-style API: NVIDIA NIM, OpenRouter, a llama.cpp server on your network, and so on.',
      'The Environment one comes from your .env file and is edited there. Add others here to try a different provider without touching the server.',
    ],
  },
  connection: {
    title: 'Connection',
    details: [
      'Where this job’s requests are sent. Pick any provider added above. Each job can use a different one, so you could write answers with a local model and keep search on NVIDIA.',
      'Whoever runs the provider sees the question and the passages sent with it.',
    ],
  },
  model: {
    title: 'Model',
    details: [
      'The exact name the provider knows the model by. Open the list to see what this connection offers, or type a name that is not listed.',
      'Save, then Test, to make sure it answers.',
    ],
  },
  preset: {
    title: 'Provider',
    details: [
      'Fills in the usual address and says what that kind of server needs. Choose Custom for anything else that speaks the OpenAI API.',
    ],
  },
  name: {
    title: 'Name',
    details: [
      'A label so you can recognise it later, like “OpenRouter” or “Office llama server”.',
    ],
  },
  baseUrl: {
    title: 'Base URL',
    details: [
      'The address of the API, usually ending in /v1.',
      'For a server on your own network, use its IP address. From inside Docker, localhost means the container itself, not your computer.',
    ],
  },
  apiKey: {
    title: 'API key',
    details: [
      'The secret the provider gave you. It is encrypted before it is stored and never shown again; only its last four characters are.',
      'When editing, leave it blank to keep the key already saved.',
    ],
  },
} as const
