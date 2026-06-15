// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title KK Token
 * @dev ERC20 代币，每个区块产出 10 个 KK，由 StakingPool 铸造分发
 */
contract KKToken is ERC20, Ownable {
    constructor() ERC20("KK Token", "KK") Ownable(msg.sender) {}

    /**
     * @dev 铸造 KK Token，仅 Owner (StakingPool) 可调用
     * @param to 接收地址
     * @param amount 铸造数量
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
