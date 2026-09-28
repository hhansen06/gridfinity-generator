# Hosting auf AWS (S3 + CloudFront)

Die App ist eine rein statische Seite. Der CDK-Stack legt an:

- privaten S3-Bucket in Frankfurt (`eu-central-1`) für den Inhalt von `dist/`
- CloudFront-Distribution mit Origin Access Control, HTTPS, HTTP/3 und Security-Headern (CSP, HSTS, …)
- optional: eigene Domain mit ACM-Zertifikat
- optional: IAM-Rolle, über die GitHub Actions per OIDC deployt (keine gespeicherten AWS-Schlüssel)

## Einmalige Einrichtung

Voraussetzungen: AWS-Konto, lokal angemeldete AWS-CLI (`aws sts get-caller-identity` funktioniert), Node 20.

```sh
cd infra
npm install
npx cdk bootstrap          # einmal pro Konto und Region
npx cdk deploy -c githubRepo=DEIN-GITHUB-USER/gridfinity-generator
```

Die Ausgaben am Ende (`BucketName`, `DistributionId`, `DeployRoleArn`, `SiteUrl`) werden gleich gebraucht.

Existiert im Konto schon ein GitHub-OIDC-Provider (pro Konto nur einer möglich), dessen ARN mitgeben:

```sh
npx cdk deploy -c githubRepo=… -c githubOidcProviderArn=arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com
```

Die Parameter lassen sich auch dauerhaft in `cdk.json` unter `context` eintragen.

### GitHub-Repository konfigurieren

Unter *Settings → Secrets and variables → Actions → Variables* anlegen:

| Variable | Wert |
| --- | --- |
| `AWS_REGION` | `eu-central-1` |
| `AWS_DEPLOY_ROLE_ARN` | Ausgabe `DeployRoleArn` |
| `S3_BUCKET` | Ausgabe `BucketName` |
| `CLOUDFRONT_DISTRIBUTION_ID` | Ausgabe `DistributionId` |

Danach deployt jeder Push auf `main` automatisch (`.github/workflows/deploy.yml`); manuell über *Actions → Deploy → Run workflow*.

## Eigene Domain (optional)

1. Zertifikat in ACM **in `us-east-1`** anfordern (CloudFront-Vorgabe) und per DNS validieren.
2. Deployen mit `-c domainName=boxen.example.de -c certificateArn=arn:aws:acm:us-east-1:…`.
3. Beim DNS-Anbieter einen CNAME von `boxen.example.de` auf die Ausgabe `DnsTarget` setzen.

## Hinweise

- Kosten: bei geringem Traffic im Cent-Bereich pro Monat (S3-Speicher, CloudFront-Requests).
- Der Bucket bleibt bei `cdk destroy` erhalten (`RETAIN`) und muss bei Bedarf manuell gelöscht werden.
- Die Content-Security-Policy steht in `lib/site-stack.ts`. Lädt die App künftig Ressourcen von fremden Domains, muss sie dort erweitert werden.
