import { Router } from 'express';
import { json } from 'express';
import { config } from '../../config.js';
import type { FeatureRoutes } from '../../features/types.js';
import { socialCallbackRouter, socialRouter, type SocialOptions } from '../../routes/social.js';
import { bufferProvider } from '../../social/providers/buffer.js';
import { linkedinProvider } from '../../social/providers/linkedin.js';
import type { SocialProvider } from '../../social/providers/types.js';
import { BUFFER_PROVIDER_KEY } from '../../social/scheduler.js';

/** Only LinkedIn and Buffer are wired today; an unconfigured provider is simply absent, not an error. */
function defaultProviders(): Record<string, SocialProvider> {
  const providers: Record<string, SocialProvider> = {};
  if (config.linkedinClientId && config.linkedinClientSecret) {
    providers.linkedin = linkedinProvider({ clientId: config.linkedinClientId, clientSecret: config.linkedinClientSecret });
  }
  if (config.bufferApiKey) providers[BUFFER_PROVIDER_KEY] = bufferProvider({ apiKey: config.bufferApiKey });
  return providers;
}

/**
 * Three mounts: a queued post carries its images as base64 (4 x 5 MB at most), so its own body
 * parser sits in the raw group ahead of the global 1 MB one; the OAuth callback arrives without a
 * session cookie, so it sits ahead of the login gates; the rest is session-gated.
 */
export const routes: FeatureRoutes = ({ opts }) => {
  const socialOpts: SocialOptions = {
    providers: defaultProviders(),
    tokenEncKey: config.socialTokenEncKey,
    redirectBaseUrl: config.socialRedirectBaseUrl,
    xMaxChars: config.socialXMaxChars,
    ...opts.social,
  };
  return [
    { path: '/api/social/posts', router: Router().use(json({ limit: '30mb' })), mount: 'raw' },
    { path: '/api/social', router: socialCallbackRouter(socialOpts), mount: 'public' },
    { path: '/api/social', router: socialRouter(socialOpts) },
  ];
};
