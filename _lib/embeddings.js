/**
 * STCKY Embeddings Module v1.0.0
 * 
 * Uses OpenAI text-embedding-3-small (1536 dims) by default
 * Large model (3072 dims) for high-value memories
 */

const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODELS = {
  small: 'text-embedding-3-small',
  large: 'text-embedding-3-large'
};

const DIMS = {
  small: 1536,
  large: 3072
};

/**
 * Generate embedding for text
 * @param {string} text - Text to embed
 * @param {string} size - 'small' (default) or 'large'
 * @returns {Promise<{embedding: number[], model: string, dims: number}>}
 */
async function embed(text, size = 'small') {
  if (!text || text.trim().length === 0) {
    return null;
  }

  const model = MODELS[size] || MODELS.small;
  const dims = DIMS[size] || DIMS.small;

  try {
    const response = await openai.embeddings.create({
      model,
      input: text.slice(0, 8000), // Token limit safety
      dimensions: dims
    });

    return {
      embedding: response.data[0].embedding,
      model,
      dims
    };
  } catch (error) {
    console.error('[EMBED] Error:', error.message);
    return null;
  }
}

/**
 * Determine embedding size based on memory type/category
 * High-value = large, everything else = small
 */
function getEmbeddingSize(category, tags = '') {
  const highValue = [
    'identity', 'preference', 'profile', 'relationship',
    'project', 'summary', 'canonical'
  ];
  
  const tagList = tags.toLowerCase();
  const cat = category.toLowerCase();
  
  for (const hv of highValue) {
    if (cat.includes(hv) || tagList.includes(hv)) {
      return 'large';
    }
  }
  
  return 'small';
}

/**
 * Embed a memory based on its content and type
 */
async function embedMemory(memory) {
  const text = `${memory.category} ${memory.key} ${memory.value} ${memory.tags || ''}`;
  const size = getEmbeddingSize(memory.category, memory.tags);
  return embed(text, size);
}

module.exports = {
  embed,
  embedMemory,
  getEmbeddingSize,
  MODELS,
  DIMS
};
