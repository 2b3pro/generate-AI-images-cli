import type { Billing, ImageProvider, Model, ModelKind, ModelSpec, Provider } from '../types';
import { getModelSpec, listModelSpecs, listOffers, resolveModel } from '../config/models';
import { ReplicateProvider } from './replicate';
import { OpenAIProvider } from './openai';
import { GoogleProvider } from './google';
import { AtlasProvider } from './atlas';
import { CodexProvider } from './codex';
import { AgyProvider } from './agy';

const providers: Map<Provider, ImageProvider> = new Map();

export function getOrCreateProvider(providerName: Provider): ImageProvider {
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
      case 'atlas':
        provider = new AtlasProvider();
        break;
      case 'codex':
        provider = new CodexProvider();
        break;
      case 'agy':
        provider = new AgyProvider();
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

export function getProviderForSpec(spec: ModelSpec): ImageProvider {
  return getOrCreateProvider(spec.provider);
}

export function listModels(): {
  model: Model;
  provider: Provider;
  kind: ModelKind;
  billing: Billing;
  description?: string;
  aliases: string[];
  deprecated?: string;
  alternatives: { provider: Provider; billing: Billing }[];
}[] {
  return listModelSpecs().map((m) => ({
    model: m.name,
    provider: m.provider,
    kind: m.kind,
    billing: m.billing,
    description: m.description,
    aliases: m.aliases,
    deprecated: m.deprecated,
    alternatives: listOffers(m.name)
      .filter((o) => o.provider !== m.provider)
      .map((o) => ({ provider: o.provider, billing: o.billing })),
  }));
}

export { ReplicateProvider, OpenAIProvider, GoogleProvider, AtlasProvider, CodexProvider, AgyProvider };
