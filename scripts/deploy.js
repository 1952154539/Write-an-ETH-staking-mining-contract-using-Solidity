const hre = require("hardhat");

async function main() {
  console.log("=== Deploying StakingPool ===\n");

  // 1. 部署 KKToken
  const KKToken = await hre.ethers.getContractFactory("KKToken");
  const kkToken = await KKToken.deploy();
  await kkToken.waitForDeployment();
  const kkTokenAddr = await kkToken.getAddress();
  console.log(`KKToken deployed to: ${kkTokenAddr}`);

  // 2. 部署 StakingPool (不启用借贷市场)
  //    若需启用借贷市场，将 address(0) 替换为借贷合约地址
  //    例如 Compound cETH: 0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5
  const lendingMarketAddr = "0x0000000000000000000000000000000000000000";

  const StakingPool = await hre.ethers.getContractFactory("StakingPool");
  const stakingPool = await StakingPool.deploy(kkTokenAddr, lendingMarketAddr);
  await stakingPool.waitForDeployment();
  const stakingPoolAddr = await stakingPool.getAddress();
  console.log(`StakingPool deployed to: ${stakingPoolAddr}`);

  // 3. 将 KKToken 的 owner 转移给 StakingPool (使 StakingPool 可以 mint)
  await kkToken.transferOwnership(stakingPoolAddr);
  console.log(`KKToken ownership transferred to StakingPool`);

  console.log("\n=== Deployment Complete ===");
  console.log(`KKToken:      ${kkTokenAddr}`);
  console.log(`StakingPool:  ${stakingPoolAddr}`);
  console.log(`LendingMarket: ${lendingMarketAddr === "0x0000000000000000000000000000000000000000" ? "Disabled" : lendingMarketAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
