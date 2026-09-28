import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface SiteStackProps extends StackProps {
  // "owner/repo" allowed to deploy via GitHub Actions OIDC.
  githubRepo?: string;
  githubBranch: string;
  // An account can hold only one GitHub OIDC provider; reuse it if present.
  githubOidcProviderArn?: string;
  domainName?: string;
  // ACM certificate for domainName; CloudFront requires it in us-east-1.
  certificateArn?: string;
}

// The app runs entirely in the browser; manifold-3d needs 'wasm-unsafe-eval',
// logos are previewed from blob: URLs and the favicon is a data: URI.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn)
      : undefined;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Gridfinity Generator',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      ...(props.domainName && certificate
        ? {
            domainNames: [props.domainName],
            certificate,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
    });

    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'SiteUrl', { value: `https://${props.domainName ?? distribution.distributionDomainName}` });
    if (props.domainName) {
      new CfnOutput(this, 'DnsTarget', {
        value: distribution.distributionDomainName,
        description: `CNAME/ALIAS-Ziel für ${props.domainName}`,
      });
    }

    if (props.githubRepo) {
      const provider = props.githubOidcProviderArn
        ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHubOidc', props.githubOidcProviderArn)
        : new iam.OidcProviderNative(this, 'GitHubOidc', {
            url: 'https://token.actions.githubusercontent.com',
            clientIds: ['sts.amazonaws.com'],
          });

      const role = new iam.Role(this, 'GitHubDeployRole', {
        description: `Deploy Gridfinity Generator from ${props.githubRepo}`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.OpenIdConnectPrincipal(provider, {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/${props.githubBranch}`,
          },
        }),
      });
      bucket.grantReadWrite(role);
      bucket.grantDelete(role);
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            Stack.of(this).formatArn({
              service: 'cloudfront',
              region: '',
              resource: 'distribution',
              resourceName: distribution.distributionId,
            }),
          ],
        }),
      );
      new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
    }
  }
}
