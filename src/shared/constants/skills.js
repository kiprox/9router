// Agent Skills metadata — single source of truth for /dashboard/skills page.
// Each skill = 1 raw GitHub URL the user copies and pastes to any AI agent.

const REPO = "decolua/9router";
const BRANCH = "master";
const SKILL_PATH = "skills";

export const SKILLS_REPO_URL = `https://github.com/${REPO}`;
export const SKILLS_RAW_BASE = `https://rawcdn.githack.com/${REPO}/refs/heads/${BRANCH}/${SKILL_PATH}`;
export const SKILLS_BLOB_BASE = `https://github.com/${REPO}/blob/${BRANCH}/${SKILL_PATH}`;

export const SKILLS = [
  {
    id: "9router",
    name: "9Router (Entry)",
    description: "Setup + index of all capabilities. Start here — covers base URL, auth, model discovery, and links to every capability skill.",
    endpoint: null,
    icon: "hub",
    isEntry: true,
  },
  {
    id: "9router-chat",
    name: "Chat",
    description: "Chat / code-gen via OpenAI or Anthropic format with streaming.",
    endpoint: "/v1/chat/completions",
    icon: "chat",
  },
  {
    id: "9router-image",
    name: "Image Generation",
    description: "Text-to-image via DALL-E, Imagen, FLUX, MiniMax, SDWebUI…",
    endpoint: "/v1/images/generations",
    icon: "image",
  },
  {
    id: "9router-tts",
    name: "Text-to-Speech",
    description: "OpenAI / ElevenLabs / Edge / Google / Deepgram voices.",
    endpoint: "/v1/audio/speech",
    icon: "record_voice_over",
  },
  {
    id: "9router-stt",
    name: "Speech-to-Text",
    description: "Transcribe audio via OpenAI Whisper, Groq, Gemini, Deepgram, AssemblyAI…",
    endpoint: "/v1/audio/transcriptions",
    icon: "mic",
  },
  {
    id: "9router-embeddings",
    name: "Embeddings",
    description: "Vectors for RAG / semantic search via OpenAI, Gemini, Mistral…",
    endpoint: "/v1/embeddings",
    icon: "scatter_plot",
  },
  {
    id: "9router-web-search",
    name: "Web Search",
    description: "Tavily / Exa / Brave / Serper / SearXNG / Google PSE / You.com.",
    endpoint: "/v1/search",
    icon: "search",
  },
  {
    id: "9router-web-fetch",
    name: "Web Fetch",
    description: "URL → markdown / text / HTML via Firecrawl, Jina, Tavily, Exa.",
    endpoint: "/v1/web/fetch",
    icon: "language",
  },
];

// Fungsi ini memproses Blob, mengambil ID-nya, lalu return konten dari Githack
export async function getSkillBlobUrl(id) {
  // 1. Bangun URL Blob-nya terlebih dahulu
  const blobUrl = `${SKILLS_BLOB_BASE}/${id}/SKILL.md`;
  
  // 2. Convert/Ekstrak ID unik dari URL Blob tersebut 
  // (Memecah URL dan mengambil nama folder-nya, yaitu ID uniknya)
  const urlParts = blobUrl.split('/');
  const uniqueId = urlParts[urlParts.length - 2]; 
  
  // 3. Gunakan ID unik tadi untuk mengakses dan mengambil hasil generate dari Githack
  const githackUrl = `${SKILLS_RAW_BASE}/${uniqueId}/SKILL.md`;
  
  try {
    const response = await fetch(githackUrl);
    
    if (!response.ok) {
      throw new Error(`Gagal mengambil data: ${response.status}`);
    }
    
    // 4. Return hasil generate mentah dari Githack (bukan URL-nya)
    return await response.text();
    
  } catch (error) {
    console.error(`Gagal convert blob ${uniqueId} dari githack:`, error);
    return null;
  }
}
