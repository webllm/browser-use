import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLlmByName } from '../src/llm/models.js';

describe('LLM models factory alignment', () => {
  const originalBrowserUseApiKey = process.env.BROWSER_USE_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAzureOpenAiApiKey = process.env.AZURE_OPENAI_API_KEY;
  const originalAzureOpenAiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const originalMistralApiKey = process.env.MISTRAL_API_KEY;
  const originalCerebrasApiKey = process.env.CEREBRAS_API_KEY;
  const originalVercelApiKey = process.env.VERCEL_API_KEY;
  const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
  const originalLiteLlmApiKey = process.env.LITELLM_API_KEY;
  const originalLiteLlmApiBase = process.env.LITELLM_API_BASE;
  const originalOciServiceEndpoint = process.env.OCI_SERVICE_ENDPOINT;
  const originalOciCompartmentId = process.env.OCI_COMPARTMENT_ID;

  beforeEach(() => {
    process.env.BROWSER_USE_API_KEY = 'test-bu-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
    process.env.MISTRAL_API_KEY = 'test-mistral-key';
    process.env.CEREBRAS_API_KEY = 'test-cerebras-key';
    process.env.VERCEL_API_KEY = 'test-vercel-key';
    process.env.GOOGLE_API_KEY = 'test-google-key';
    process.env.LITELLM_API_KEY = 'test-litellm-key';
    process.env.LITELLM_API_BASE = 'https://litellm.example.com';
    process.env.OCI_SERVICE_ENDPOINT =
      'https://inference.generativeai.example.oraclecloud.com';
    process.env.OCI_COMPARTMENT_ID = 'ocid1.compartment.oc1..example';
  });

  afterEach(() => {
    if (originalBrowserUseApiKey === undefined) {
      delete process.env.BROWSER_USE_API_KEY;
    } else {
      process.env.BROWSER_USE_API_KEY = originalBrowserUseApiKey;
    }
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    if (originalAzureOpenAiApiKey === undefined) {
      delete process.env.AZURE_OPENAI_API_KEY;
    } else {
      process.env.AZURE_OPENAI_API_KEY = originalAzureOpenAiApiKey;
    }
    if (originalAzureOpenAiEndpoint === undefined) {
      delete process.env.AZURE_OPENAI_ENDPOINT;
    } else {
      process.env.AZURE_OPENAI_ENDPOINT = originalAzureOpenAiEndpoint;
    }
    if (originalMistralApiKey === undefined) {
      delete process.env.MISTRAL_API_KEY;
    } else {
      process.env.MISTRAL_API_KEY = originalMistralApiKey;
    }
    if (originalCerebrasApiKey === undefined) {
      delete process.env.CEREBRAS_API_KEY;
    } else {
      process.env.CEREBRAS_API_KEY = originalCerebrasApiKey;
    }
    if (originalVercelApiKey === undefined) {
      delete process.env.VERCEL_API_KEY;
    } else {
      process.env.VERCEL_API_KEY = originalVercelApiKey;
    }
    if (originalGoogleApiKey === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = originalGoogleApiKey;
    }
    if (originalLiteLlmApiKey === undefined) {
      delete process.env.LITELLM_API_KEY;
    } else {
      process.env.LITELLM_API_KEY = originalLiteLlmApiKey;
    }
    if (originalLiteLlmApiBase === undefined) {
      delete process.env.LITELLM_API_BASE;
    } else {
      process.env.LITELLM_API_BASE = originalLiteLlmApiBase;
    }
    if (originalOciServiceEndpoint === undefined) {
      delete process.env.OCI_SERVICE_ENDPOINT;
    } else {
      process.env.OCI_SERVICE_ENDPOINT = originalOciServiceEndpoint;
    }
    if (originalOciCompartmentId === undefined) {
      delete process.env.OCI_COMPARTMENT_ID;
    } else {
      process.env.OCI_COMPARTMENT_ID = originalOciCompartmentId;
    }
  });

  it('parses python-style OpenAI model names', () => {
    const llm = getLlmByName('openai_gpt_4_1_mini');
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-4.1-mini');
  });

  it('parses python-style Google model names', () => {
    const llm = getLlmByName('google_gemini_2_5_flash_lite');
    expect(llm.provider).toBe('google');
    expect(llm.model).toBe('gemini-2.5-flash-lite');
  });

  it('supports browser-use aliases from python llm.models', () => {
    const latest = getLlmByName('bu_latest');
    const explicit = getLlmByName('bu_2_0');
    expect(latest.provider).toBe('browser-use');
    expect(latest.model).toBe('bu-2-0');
    expect(explicit.provider).toBe('browser-use');
    expect(explicit.model).toBe('bu-2-0');
  });

  it('infers provider for plain model names', () => {
    const llm = getLlmByName('gpt-5-mini');
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-5-mini');
  });

  it('supports provider-prefixed model aliases used in CLI', () => {
    const llm = getLlmByName('azure:gpt-4o');
    expect(llm.provider).toBe('azure');
    expect(llm.model).toBe('gpt-4o');
  });

  it('supports mistral aliases from python llm.models', () => {
    const large = getLlmByName('mistral_large');
    const code = getLlmByName('codestral');
    expect(large.provider).toBe('mistral');
    expect(large.model).toBe('mistral-large-latest');
    expect(code.provider).toBe('mistral');
    expect(code.model).toBe('codestral-latest');
  });

  it('parses python-style Cerebras model names', () => {
    const llm = getLlmByName('cerebras_llama3_1_8b');
    expect(llm.provider).toBe('cerebras');
    expect(llm.model).toBe('llama3.1-8b');
  });

  it('resolves current Cerebras catalog aliases', () => {
    expect(getLlmByName('cerebras_gpt_oss_120b').model).toBe('gpt-oss-120b');
    expect(getLlmByName('cerebras_zai_glm_4_7').model).toBe('zai-glm-4.7');
    expect(getLlmByName('cerebras_gemma_4_31b').model).toBe('gemma-4-31b');
    expect(getLlmByName('zai-glm-4.7').provider).toBe('cerebras');
  });

  it('remaps the retired Pixtral Large alias to Mistral Medium', () => {
    const llm = getLlmByName('pixtral_large');
    expect(llm.provider).toBe('mistral');
    expect(llm.model).toBe('mistral-medium-latest');
  });

  it('supports provider-prefixed Vercel model aliases', () => {
    const llm = getLlmByName('vercel:openai/gpt-5-mini');
    expect(llm.provider).toBe('vercel');
    expect(llm.model).toBe('openai/gpt-5-mini');
  });

  it('parses python-style LiteLLM model names', () => {
    const llm = getLlmByName('litellm_gpt_4_1_mini');
    expect(llm.provider).toBe('litellm');
    expect(llm.model).toBe('gpt-4.1-mini');
  });

  it('throws for unrecognized model names', () => {
    expect(() => getLlmByName('not-a-valid-model-name')).toThrow(
      /Invalid model name format/
    );
  });

  it('builds OCI models through the shared model factory', () => {
    const llm = getLlmByName('oci_ocid1.generativeaimodel.oc1.region.example');
    expect(llm.provider).toBe('oci-raw');
    expect(llm.model).toBe('ocid1.generativeaimodel.oc1.region.example');
  });
});
