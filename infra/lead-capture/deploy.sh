#!/usr/bin/env bash
# One-shot deploy of the lead-capture Lambda + public Function URL that writes
# visitor email/company into the client-data-access bucket.
#
# Run with an AWS profile/credentials that can create IAM roles + Lambda
# functions in account 886989006633 (the account that owns the bucket). The
# scoped boristomov / S3ClientAccessRole keys in Secrets/ CANNOT do this.
#
# Usage:
#   AWS_PROFILE=admin ./deploy.sh
#   # or: AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./deploy.sh
#
# After it prints the Function URL, set it as a GitHub repo variable so the
# deploy workflow bakes it into the site:
#   gh variable set VITE_LEAD_ENDPOINT --body "<the printed URL>"
set -euo pipefail

REGION="${REGION:-ap-southeast-1}"
BUCKET="${BUCKET:-client-data-access}"
PREFIX="${PREFIX:-leads}"
FUNC="${FUNC:-ego-lead-capture}"
ROLE="${ROLE:-ego-lead-capture-role}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "account=$ACCOUNT region=$REGION bucket=$BUCKET func=$FUNC"

# ---- IAM role ----
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "creating role $ROLE"
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document "$TRUST" >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "waiting for role to propagate..."
  sleep 12
fi

# Scoped write-only policy to the leads/ prefix.
PUT_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/$PREFIX/*\"}]}"
aws iam put-role-policy --role-name "$ROLE" \
  --policy-name "write-${BUCKET}-${PREFIX}" \
  --policy-document "$PUT_POLICY"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"
echo "role=$ROLE_ARN"

# ---- package ----
TMP="$(mktemp -d)"
cp "$HERE/index.mjs" "$TMP/index.mjs"
( cd "$TMP" && zip -q function.zip index.mjs )

# ---- function (create or update) ----
if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  echo "updating function code"
  aws lambda update-function-code --function-name "$FUNC" --region "$REGION" \
    --zip-file "fileb://$TMP/function.zip" >/dev/null
  aws lambda update-function-configuration --function-name "$FUNC" --region "$REGION" \
    --environment "Variables={BUCKET=$BUCKET,PREFIX=$PREFIX}" >/dev/null
else
  echo "creating function $FUNC"
  aws lambda create-function --function-name "$FUNC" --region "$REGION" \
    --runtime nodejs20.x --handler index.handler --role "$ROLE_ARN" \
    --timeout 10 --memory-size 128 \
    --environment "Variables={BUCKET=$BUCKET,PREFIX=$PREFIX}" \
    --zip-file "fileb://$TMP/function.zip" >/dev/null
fi

# ---- public Function URL + CORS ----
if ! aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FUNC" --region "$REGION" \
    --auth-type NONE \
    --cors 'AllowOrigins=*,AllowMethods=POST,AllowHeaders=content-type' >/dev/null
  # Allow public (unauthenticated) invoke of the Function URL.
  aws lambda add-permission --function-name "$FUNC" --region "$REGION" \
    --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal '*' \
    --function-url-auth-type NONE >/dev/null 2>&1 || true
fi

URL="$(aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" --query FunctionUrl --output text)"
rm -rf "$TMP"

echo
echo "============================================================"
echo " Function URL: $URL"
echo "------------------------------------------------------------"
echo " Wire it into the site:"
echo "   gh variable set VITE_LEAD_ENDPOINT --body \"$URL\""
echo " then re-run the deploy workflow (or push)."
echo "============================================================"
