import { App } from 'aws-cdk-lib';
import { SiteStack } from '../lib/site-stack.ts';

const app = new App();
const ctx = (key: string): string | undefined => app.node.tryGetContext(key) || undefined;

new SiteStack(app, 'GridfinityGenerator', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: ctx('region') ?? 'eu-central-1',
  },
  githubRepo: ctx('githubRepo'),
  githubOwnerId: ctx('githubOwnerId'),
  githubRepoId: ctx('githubRepoId'),
  githubBranch: ctx('githubBranch') ?? 'main',
  githubOidcProviderArn: ctx('githubOidcProviderArn'),
  domainName: ctx('domainName'),
  certificateArn: ctx('certificateArn'),
});
