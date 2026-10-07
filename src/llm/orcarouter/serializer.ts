import { OpenAIMessageSerializer } from '../openai/serializer.js';

export class OrcaRouterMessageSerializer extends OpenAIMessageSerializer {
  // OrcaRouter accepts OpenAI chat completion messages unchanged.
}
