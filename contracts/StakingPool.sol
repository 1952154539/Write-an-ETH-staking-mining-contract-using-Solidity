// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IStaking.sol";
import "./ILendingMarket.sol";
import "./IToken.sol";

/**
 * @title StakingPool
 * @dev ETH 质押挖矿合约，质押 ETH 赚取 KK Token
 *
 * ## 核心算法：累积每代币奖励累加器
 *
 * 由于 EVM Gas 限制，无法遍历所有用户逐块分配奖励。本合约采用
 * Unipool/StakingRewards 的 "accumulator" 模式：
 *
 *   rewardPerTokenStored = Σ (REWARD_PER_BLOCK * 1e18 / totalSupply)  每个区块累加
 *
 *   用户奖励 = balance[user] * (rewardPerToken() - userRewardPerTokenPaid[user]) / 1e18
 *
 * 该算法确保：
 *   - O(1) Gas 复杂度，与用户总数无关
 *   - 质押时间越长，(rewardPerToken - snapshot) 差值越大 → 时间权重
 *   - 质押数量越大，乘积越大 → 数量权重
 *
 * ## 借贷市场集成 (加分项)
 *
 * 质押的 ETH 可存入 Compound cETH 等借贷协议赚取额外利息。
 * 赎回时按比例分配利息收益。
 */
contract StakingPool is IStaking, ReentrancyGuard {
    // ============ 常量 ============

    /// @dev 每个区块产出的 KK Token 数量 (精度 1e18)
    uint256 public constant REWARD_PER_BLOCK = 10 ether;

    // ============ 状态变量 ============

    /// @dev KK Token 合约
    IToken public immutable kkToken;

    /// @dev 借贷市场合约 (address(0) 表示未启用)
    ILendingMarket public immutable lendingMarket;

    /// @dev 总质押 ETH 数量
    uint256 public totalSupply;

    /// @dev 累积每代币奖励 (精度 1e18)
    uint256 public rewardPerTokenStored;

    /// @dev 上次更新奖励的区块号
    uint256 public lastBlockNumber;

    /// @dev 用户质押余额
    mapping(address => uint256) private _balances;

    /// @dev 用户上次结算时的 rewardPerTokenStored 快照
    mapping(address => uint256) private _userRewardPerTokenPaid;

    /// @dev 用户已结算但未领取的奖励
    mapping(address => uint256) private _rewards;

    // ============ 事件 ============

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardClaimed(address indexed user, uint256 amount);

    // ============ 构造函数 ============

    /**
     * @param _kkToken KK Token 合约地址
     * @param _lendingMarket 借贷市场合约地址，传 address(0) 禁用借贷集成
     */
    constructor(address _kkToken, address _lendingMarket) {
        require(_kkToken != address(0), "Invalid KK token address");
        kkToken = IToken(_kkToken);
        lendingMarket = ILendingMarket(_lendingMarket);
        lastBlockNumber = block.number;
    }

    // ============ 修饰器 ============

    /**
     * @dev 更新全局奖励累加器并结算该用户的待领奖励
     */
    modifier updateReward(address account) {
        rewardPerTokenStored = _rewardPerToken();
        lastBlockNumber = block.number;

        if (account != address(0)) {
            _rewards[account] = _earned(account);
            _userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ============ 外部函数 ============

    /**
     * @dev 质押 ETH 到合约
     *      同时将 ETH 存入借贷市场赚取利息 (如已配置)
     */
    function stake() external payable override nonReentrant updateReward(msg.sender) {
        require(msg.value > 0, "Cannot stake 0");

        _balances[msg.sender] += msg.value;
        totalSupply += msg.value;

        // 存入借贷市场赚取利息 (加分项)
        if (address(lendingMarket) != address(0)) {
            lendingMarket.mint{value: msg.value}();
        }

        emit Staked(msg.sender, msg.value);
    }

    /**
     * @dev 赎回质押的 ETH
     * @param amount 赎回数量 (wei)
     */
    function unstake(uint256 amount) external override nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot unstake 0");
        require(_balances[msg.sender] >= amount, "Insufficient balance");

        _balances[msg.sender] -= amount;
        totalSupply -= amount;

        // 从借贷市场赎回 ETH (加分项)
        _redeemFromLending(amount);

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "ETH transfer failed");

        emit Unstaked(msg.sender, amount);
    }

    /**
     * @dev 领取 KK Token 收益
     */
    function claim() external override nonReentrant updateReward(msg.sender) {
        uint256 reward = _rewards[msg.sender];
        require(reward > 0, "No rewards to claim");

        _rewards[msg.sender] = 0;
        kkToken.mint(msg.sender, reward);

        emit RewardClaimed(msg.sender, reward);
    }

    // ============ 视图函数 ============

    /**
     * @dev 获取质押的 ETH 数量
     */
    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    /**
     * @dev 获取待领取的 KK Token 收益
     */
    function earned(address account) external view override returns (uint256) {
        return _earned(account);
    }

    /**
     * @dev 查询当前累积每代币奖励值 (含未结算区块)
     */
    function rewardPerToken() external view returns (uint256) {
        return _rewardPerToken();
    }

    // ============ 内部函数 ============

    /**
     * @dev 计算当前累积每代币奖励
     *
     * 公式: rewardPerTokenStored + (elapsedBlocks * REWARD_PER_BLOCK * 1e18) / totalSupply
     *
     * 当 totalSupply == 0 时，不累积奖励 (无人质押期间的奖励作废)
     */
    function _rewardPerToken() private view returns (uint256) {
        if (totalSupply == 0) {
            return rewardPerTokenStored;
        }
        uint256 blocks = block.number - lastBlockNumber;
        return rewardPerTokenStored + (blocks * REWARD_PER_BLOCK * 1e18) / totalSupply;
    }

    /**
     * @dev 计算用户待领取奖励
     *
     * 公式: _rewards[account] + balance * (currentRewardPerToken - userSnapshot) / 1e18
     */
    function _earned(address account) private view returns (uint256) {
        return _rewards[account]
            + (_balances[account] * (_rewardPerToken() - _userRewardPerTokenPaid[account])) / 1e18;
    }

    /**
     * @dev 从借贷市场按比例赎回 ETH
     *
     * 赎回逻辑:
     *   用户持有的 cToken 份额 = userPrincipal / totalPrincipal (赎回前)
     *   赎回 cToken 数量 = 份额 * totalCTokenBalance
     *
     * 利息自动分配: 由于 cToken 汇率随时间增长，按比例赎回时
     * 用户自动获得其本金加应计利息。
     *
     * @param principalAmount 用户赎回的本金数量
     */
    function _redeemFromLending(uint256 principalAmount) private {
        if (address(lendingMarket) == address(0)) return;

        uint256 cTokenBalance = lendingMarket.balanceOf(address(this));
        if (cTokenBalance == 0) return;

        // 用户本金对应总本金 (赎回前的 totalSupply 已扣减, 需要还原)
        uint256 totalPrincipalBefore = totalSupply + principalAmount;

        // 按比例计算赎回的 cToken 数量
        uint256 cTokenToRedeem = (principalAmount * cTokenBalance) / totalPrincipalBefore;

        if (cTokenToRedeem > 0) {
            lendingMarket.redeem(cTokenToRedeem);
        }
    }

    // ============ Receive ============

    /// @dev 接收 ETH (借贷市场赎回 ETH 时会回调)
    receive() external payable {}
}
