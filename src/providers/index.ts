import type { ImageProvider, Model, Provider } from '../types';
import { getModelSpec, listModelSpecs, resolveModel } from '../config/models';
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

export function getProviderForModel(modelInput: string): ImageProvider {
  const model = resolveModel(modelInput);
  return getOrCreateProvider(getModelSpec(model).provider);
}

export function listModels(): { model: Model; provider: Provider; kind: 'image' | 'video'; description?: string; aliases: string[]; deprecated?: string }[] {
  return listModelSpecs().map((m) => ({
    model: m.name,
    provider: m.provider,
    kind: m.kind,
    description: m.description,
    aliases: m.aliases,
    deprecated: m.deprecated,
  }));
}

export { ReplicateProvider, OpenAIProvider, GoogleProvider };
