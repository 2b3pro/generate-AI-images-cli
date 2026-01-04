import type { ImageProvider, Model, Provider } from '../types';
import { MODEL_TO_PROVIDER } from '../types';
import { ReplicateProvider } from './replicate';
import { OpenAIProvider } from './openai';
import { GoogleProvider } from './google';

const providers: Map<Provider, ImageProvider> = new Map();

function getOrCreateProvider(providerName: Provider): ImageProvider {
  let provider = providers.get(providerName);

  if (!provider) {
    switch (providerName) {
      case 'replicate':
        provider = new ReplicateProvider();
        break;
      case 'openai':
        provider = new OpenAIProvider();
        break;
      case 'google':
        provider = new GoogleProvider();
        break;
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
    providers.set(providerName, provider);
  }

  return provider;
}

export function getProviderForModel(model: Model): ImageProvider {
  const providerName = MODEL_TO_PROVIDER[model];

  if (!providerName) {
    throw new Error(`Unknown model: ${model}. Available models: ${Object.keys(MODEL_TO_PROVIDER).join(', ')}`);
  }

  return getOrCreateProvider(providerName);
}

export function listModels(): { model: Model; provider: Provider }[] {
  return Object.entries(MODEL_TO_PROVIDER).map(([model, provider]) => ({
    model: model as Model,
    provider,
  }));
}

export { ReplicateProvider, OpenAIProvider, GoogleProvider };
