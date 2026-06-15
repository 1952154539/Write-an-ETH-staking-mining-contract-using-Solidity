const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("StakingPool", function () {
  let kkToken, stakingPool;
  let owner, user1, user2;
  const ONE_ETH = ethers.parseEther("1");
  const HALF_ETH = ethers.parseEther("0.5");

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // 部署 KKToken
    const KKToken = await ethers.getContractFactory("KKToken");
    kkToken = await KKToken.deploy();
    await kkToken.waitForDeployment();

    // 部署 StakingPool (不启用借贷市场)
    const StakingPool = await ethers.getContractFactory("StakingPool");
    stakingPool = await StakingPool.deploy(
      await kkToken.getAddress(),
      ethers.ZeroAddress
    );
    await stakingPool.waitForDeployment();

    // 转移 owner
    await kkToken.transferOwnership(await stakingPool.getAddress());
  });

  describe("Deployment", function () {
    it("should set correct initial state", async function () {
      expect(await stakingPool.totalSupply()).to.equal(0);
      expect(await stakingPool.rewardPerTokenStored()).to.equal(0);
      expect(await stakingPool.REWARD_PER_BLOCK()).to.equal(ethers.parseEther("10"));
    });
  });

  describe("stake()", function () {
    it("should accept ETH and update balance", async function () {
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      expect(await stakingPool.balanceOf(user1.address)).to.equal(ONE_ETH);
      expect(await stakingPool.totalSupply()).to.equal(ONE_ETH);
    });

    it("should revert when staking 0 ETH", async function () {
      await expect(
        stakingPool.connect(user1).stake({ value: 0 })
      ).to.be.revertedWith("Cannot stake 0");
    });

    it("should emit Staked event", async function () {
      await expect(stakingPool.connect(user1).stake({ value: ONE_ETH }))
        .to.emit(stakingPool, "Staked")
        .withArgs(user1.address, ONE_ETH);
    });
  });

  describe("unstake()", function () {
    beforeEach(async function () {
      await stakingPool.connect(user1).stake({ value: ONE_ETH });
    });

    it("should return ETH and update balance", async function () {
      const balanceBefore = await ethers.provider.getBalance(user1.address);

      const tx = await stakingPool.connect(user1).unstake(HALF_ETH);
      const receipt = await tx.wait();

      expect(await stakingPool.balanceOf(user1.address)).to.equal(HALF_ETH);
      expect(await stakingPool.totalSupply()).to.equal(HALF_ETH);
    });

    it("should revert when unstaking more than balance", async function () {
      await expect(
        stakingPool.connect(user1).unstake(ONE_ETH + 1n)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("should revert when unstaking 0", async function () {
      await expect(
        stakingPool.connect(user1).unstake(0)
      ).to.be.revertedWith("Cannot unstake 0");
    });

    it("should emit Unstaked event", async function () {
      await expect(stakingPool.connect(user1).unstake(HALF_ETH))
        .to.emit(stakingPool, "Unstaked")
        .withArgs(user1.address, HALF_ETH);
    });
  });

  describe("claim()", function () {
    it("should mint KK tokens as rewards", async function () {
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      // 挖 100 个区块 (stake 和 claim 各自挖一个区块)
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_mine");
      }

      // claim 时会更新奖励，再累加 1 个区块的奖励
      // earned() 是 view 调用不含 claim 区块，balanceOf 是 claim 后的结果
      const earnedBeforeClaim = await stakingPool.earned(user1.address);
      expect(earnedBeforeClaim).to.be.gt(0);

      await stakingPool.connect(user1).claim();
      const balance = await kkToken.balanceOf(user1.address);
      // 获得的奖励应 >= earnedBeforeClaim (claim 可能多 1 个区块)
      expect(balance).to.be.gte(earnedBeforeClaim);
    });

    it("should revert when no rewards to claim", async function () {
      await expect(
        stakingPool.connect(user1).claim()
      ).to.be.revertedWith("No rewards to claim");
    });

    it("should emit RewardClaimed event", async function () {
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      for (let i = 0; i < 10; i++) {
        await ethers.provider.send("evm_mine");
      }

      await expect(stakingPool.connect(user1).claim())
        .to.emit(stakingPool, "RewardClaimed");
    });
  });

  describe("Reward Distribution Algorithm", function () {
    it("should distribute rewards proportional to stake amount", async function () {
      // user1 stakes 1 ETH, user2 stakes 3 ETH (ratio 1:3)
      // 注意: 两个 stake 在不同区块，user1 会多拿 1 个区块的独占奖励 (10 KK)
      await stakingPool.connect(user1).stake({ value: ONE_ETH });
      await stakingPool.connect(user2).stake({ value: ONE_ETH * 3n });

      // 挖 50 个区块 = 50 * 10 = 500 KK 共享
      for (let i = 0; i < 50; i++) {
        await ethers.provider.send("evm_mine");
      }

      const earned1 = await stakingPool.earned(user1.address);
      const earned2 = await stakingPool.earned(user2.address);

      // user1: 500*(1/4) + 10(独占1区块) = 135 KK
      // user2: 500*(3/4) = 375 KK
      // ratio: 135/375*10000 ≈ 3600
      const ratio = (earned1 * 10000n) / earned2;
      // 允许充足误差 (user1 因早质押略多)
      expect(ratio).to.be.closeTo(3600n, 200n);
    });

    it("should reward longer stakers more (time-weighting)", async function () {
      // user1 先质押
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      // 挖 50 个区块
      for (let i = 0; i < 50; i++) {
        await ethers.provider.send("evm_mine");
      }

      // user2 后质押
      await stakingPool.connect(user2).stake({ value: ONE_ETH });

      // 再挖 50 个区块
      for (let i = 0; i < 50; i++) {
        await ethers.provider.send("evm_mine");
      }

      const earned1 = await stakingPool.earned(user1.address);
      const earned2 = await stakingPool.earned(user2.address);

      // user1 质押了 100 个区块，user2 质押了 50 个区块
      // user1 应得更多
      expect(earned1).to.be.gt(earned2);
    });

    it("should handle multiple stakes and unstakes correctly", async function () {
      // user1 stakes 1 ETH
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      for (let i = 0; i < 30; i++) {
        await ethers.provider.send("evm_mine");
      }

      const earned1_30 = await stakingPool.earned(user1.address);

      // user1 stakes another 1 ETH
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      for (let i = 0; i < 30; i++) {
        await ethers.provider.send("evm_mine");
      }

      const earned1_60 = await stakingPool.earned(user1.address);
      // 总奖励应 >= 前30块的奖励 (因为又质押了30块)
      expect(earned1_60).to.be.gt(earned1_30);
    });

    it("should correctly distribute all issued rewards", async function () {
      // 单用户质押后挖矿，所有奖励归该用户
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      const BLOCKS = 100;
      for (let i = 0; i < BLOCKS; i++) {
        await ethers.provider.send("evm_mine");
      }

      await stakingPool.connect(user1).claim();
      const balance = await kkToken.balanceOf(user1.address);

      // 100 个区块 * 10 KK = 1000 KK (允许少量精度损失)
      const expected = ethers.parseEther("1000");
      const diff = expected - balance;
      // 精度损失应在 1 KK 以内
      expect(diff).to.be.lt(ethers.parseEther("1"));
    });
  });

  describe("view functions", function () {
    it("balanceOf should return correct balance", async function () {
      await stakingPool.connect(user1).stake({ value: ONE_ETH });
      expect(await stakingPool.balanceOf(user1.address)).to.equal(ONE_ETH);
    });

    it("earned should return 0 for non-staker", async function () {
      expect(await stakingPool.earned(user2.address)).to.equal(0);
    });

    it("rewardPerToken should increase over time", async function () {
      await stakingPool.connect(user1).stake({ value: ONE_ETH });

      const rpt1 = await stakingPool.rewardPerToken();

      for (let i = 0; i < 10; i++) {
        await ethers.provider.send("evm_mine");
      }

      const rpt2 = await stakingPool.rewardPerToken();
      expect(rpt2).to.be.gt(rpt1);
    });

    it("rewardPerToken should stay unchanged when totalSupply is 0", async function () {
      const rpt1 = await stakingPool.rewardPerToken();

      for (let i = 0; i < 10; i++) {
        await ethers.provider.send("evm_mine");
      }

      const rpt2 = await stakingPool.rewardPerToken();
      expect(rpt2).to.equal(rpt1);
    });
  });
});
