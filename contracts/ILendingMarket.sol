// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title 借贷市场接口
 * @dev 兼容 Compound cETH 等借贷协议
 *      参考: https://github.com/compound-finance/compound-protocol
 *
 * 在 Ethereum 主网上，cETH 合约地址为:
 *   0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5
 */
interface ILendingMarket {
    /**
     * @dev 存入 ETH 并铸造 cToken
     *      Compound cETH: 发送 ETH 调用 mint() 获取 cETH
     */
    function mint() external payable;

    /**
     * @dev 销毁 cToken 赎回 ETH
     * @param redeemTokens 要销毁的 cToken 数量
     * @return 错误码，0 表示成功
     *     Compound cETH: 调用 redeem(cTokenAmount) 获取 ETH
     */
    function redeem(uint256 redeemTokens) external returns (uint256);

    /**
     * @dev 查询当前汇率 (ETH / cToken, 精度 1e18)
     * @return 1 个 cToken 可兑换的 ETH 数量 (wei)
     *     Compound: exchangeRateStored() 返回汇率，随利息累积而增长
     */
    function exchangeRateStored() external view returns (uint256);

    /**
     * @dev 查询 cToken 余额
     * @param account 账户地址
     * @return cToken 数量
     */
    function balanceOf(address account) external view returns (uint256);
}
