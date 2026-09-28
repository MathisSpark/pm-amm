#!/bin/bash
# Deploy pm-AMM to devnet
# Prerequisites: the devnet upgrade authority (ETGKSFc7…, a dedicated key — not
# id.json) with ~8 SOL free for the upgrade buffer (refunded).
set -e

KEYPAIR="${DEVNET_UPGRADE_KEYPAIR:-$HOME/.config/solana/pm-amm-devnet-upgrade.json}"

echo "=== pm-AMM Devnet Deploy ==="

# Ensure devnet
solana config set --url devnet

# Check balance
BALANCE=$(solana balance -k "$KEYPAIR" | awk '{print $1}')
echo "Balance: $BALANCE SOL"
if (( $(echo "$BALANCE < 4" | bc -l) )); then
    echo "Need at least 4 SOL for deploy. Requesting airdrop..."
    solana airdrop 2 -k "$KEYPAIR" || true
    sleep 2
    solana airdrop 2 -k "$KEYPAIR" || true
    sleep 2
fi

# Build
echo "Building..."
cd "$(dirname "$0")/.."
anchor build --no-idl -- --tools-version v1.52
anchor idl build -o target/idl/pm_amm.json

# Deploy
echo "Deploying..."
solana program deploy target/deploy/pm_amm.so \
    --program-id target/deploy/pm_amm-keypair.json \
    --keypair "$KEYPAIR" \
    --url devnet

PROGRAM_ID=$(solana address -k target/deploy/pm_amm-keypair.json)
echo ""
echo "=== Deployed ==="
echo "Program ID: $PROGRAM_ID"
echo "Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
