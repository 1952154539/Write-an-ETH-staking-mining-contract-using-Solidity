# ETH 质押挖矿合约 (StakingPool)

基于 Solidity 实现的 ETH 质押挖矿合约，质押 ETH 赚取 KK Token 奖励。奖励根据**质押时间**和**质押数量**精准分配。

## 核心算法：累积每代币奖励累加器

### 问题背景

EVM 中每个状态变更都消耗 Gas，且有区块 Gas 上限。如果每个区块遍历所有质押者来分配奖励，Gas 成本随用户数线性增长，无法扩展到大量用户。

### 解决方案

采用 **Unipool / StakingRewards 累加器模式**，每次用户交互时结算其应得奖励，全局仅维护一个累加器变量。

### 数学推导

定义：
- `R`：每个区块产出的 KK Token 数量（10 KK）
- `S_n`：第 n 个区块的总质押量
- `T_n`：第 n 个区块的「累积每质押代币奖励」

```
T_n = T_{n-1} + (R × 1e18) / S_n
```

当用户在第 `m` 区块质押 `b` 个 ETH，在第 `n` 区块结算时，奖励为：

```
奖励 = b × (T_n - T_m)
```

**时间权重**：质押越久，`(T_n - T_m)` 差值越大  
**数量权重**：质押量 `b` 直接放大奖励

### 多次质押场景

若用户分批质押（先质押 `b`，后追加 `d`），则分段计算：
1. 第一段：`b × (T_mid - T_m)`
2. 第二段：`(b + d) × (T_n - T_mid)`

合约通过记录 `userRewardPerTokenPaid` 快照自动处理任意次操作。

### 算法优势

| 特性 | 说明 |
|------|------|
| O(1) Gas | 每次操作 Gas 消耗恒定，与总用户数无关 |
| 精确时间加权 | `T_n` 精确反映每个区块的份额变化 |
| 任意次操作 | 支持无限次 stake/unstake，分段叠加保证正确 |

## 合约架构

```
contracts/
├── KKToken.sol          # KK Token (ERC20)，每区块产出 10 KK
├── StakingPool.sol      # 质押挖矿核心合约
├── IStaking.sol         # 质押接口
├── IToken.sol           # KK Token 接口
└── ILendingMarket.sol   # 借贷市场接口 (加分项)
```

### KKToken

ERC20 代币，`mint()` 权限仅限 Owner（StakingPool 合约），确保只有质押挖矿能产出新 Token。

```solidity
contract KKToken is ERC20, Ownable {
    function mint(address to, uint256 amount) external onlyOwner;
}
```

### StakingPool

核心合约，实现 `IStaking` 接口：

```solidity
interface IStaking {
    function stake() external payable;           // 质押 ETH
    function unstake(uint256 amount) external;   // 赎回 ETH
    function claim() external;                   // 领取 KK Token
    function balanceOf(address) external view returns (uint256);  // 查询质押量
    function earned(address) external view returns (uint256);     // 查询待领奖励
}
```

**关键参数：**
- `REWARD_PER_BLOCK = 10 ether`（每区块 10 KK）
- `rewardPerTokenStored`：全局累积每代币奖励
- `lastBlockNumber`：上次更新区块号
- 精度缩放：所有计算使用 `1e18` 精度

## 借贷市场集成（加分项）

合约支持将质押的 ETH 存入 Compound cETH 等借贷协议赚取额外利息。

### 工作原理

```
用户 --stake ETH--> StakingPool --mint cETH--> Compound
                                                 |
                                           cETH 汇率增长
                                                 |
用户 <-unstake ETH-- StakingPool <-redeem cETH---+
```

### 利息分配

按比例赎回机制：
- 用户赎回时，按 `userPrincipal / totalPrincipal` 比例赎回对应的 cToken
- cToken 汇率随时间增长，赎回的 ETH 自动包含本金和利息
- 无需额外的利息计算逻辑

### 借贷市场接口

```solidity
interface ILendingMarket {
    function mint() external payable;                         // 存入 ETH
    function redeem(uint256 redeemTokens) external returns (uint256);  // 赎回 ETH
    function exchangeRateStored() external view returns (uint256);    // 汇率
    function balanceOf(address) external view returns (uint256);      // cToken 余额
}
```

### 启用方式

部署时传入借贷市场地址（非零地址即启用）：

| 网络 | Compound cETH 地址 |
|------|-------------------|
| Ethereum Mainnet | `0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5` |
| 不启用 | `0x0000000000000000000000000000000000000000` |

## 快速开始

### 环境要求

- Node.js >= 16
- npm >= 8

### 安装

```bash
git clone https://github.com/1952154539/Write-an-ETH-staking-mining-contract-using-Solidity.git
cd Write-an-ETH-staking-mining-contract-using-Solidity
npm install
```

### 编译

```bash
npx hardhat compile
```

### 测试

```bash
npx hardhat test
```

测试覆盖：
- 质押/赎回基本流程
- KK Token 奖励领取
- 按数量比例分配（1:3 质押比例 → 1:3 奖励比例）
- 按时间权重分配（早质押者获得更多奖励）
- 多次质押/赎回的正确性
- 边界条件（质押 0、赎回超额、无奖励领取等）

### 部署

```bash
npx hardhat run scripts/deploy.js --network <your-network>
```

## 使用流程

```javascript
// 1. 质押 1 ETH
await stakingPool.stake({ value: ethers.parseEther("1") });

// 2. 查询待领取的 KK Token
const pending = await stakingPool.earned(userAddress);

// 3. 领取 KK Token 奖励
await stakingPool.claim();

// 4. 赎回部分或全部 ETH
await stakingPool.unstake(ethers.parseEther("0.5"));

// 5. 查询当前质押余额
const balance = await stakingPool.balanceOf(userAddress);
```

## 安全设计

- **ReentrancyGuard**：所有状态变更函数使用重入锁保护
- **CEI 模式**：先更新状态，再执行外部调用
- **Ownable 权限控制**：KK Token 的 `mint()` 仅限 StakingPool 调用
- **immutable 变量**：KK Token 和借贷市场地址不可更改

## 参考资料

- [Unipool 质押挖矿算法详解](https://learnblockchain.cn/article/3950)
- [质押合约实现分析](https://learnblockchain.cn/article/6380)
- [Compound DeFi 案例分析](https://github.com/OpenSpace100/blockchain-tasks/blob/main/ppt/DeFi-StudyCase-Compound.pdf)

## License

MIT
