// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAgentRegistry {
    function agentKeyToTokenId(bytes32 key) external view returns (uint256);
    function payoutWallets(uint256 tokenId) external view returns (address);
}

contract ClawdPayments is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IAgentRegistry public immutable agentRegistry;
    address public platformWallet;

    uint256 public constant AGENT_TIP_SHARE = 8000;
    uint256 public constant PLATFORM_TIP_SHARE = 2000;
    uint256 public constant BASIS_POINTS = 10000;

    event TipSent(
        string indexed agentId,
        address indexed tipper,
        uint256 amount,
        uint256 agentShare,
        uint256 platformShare,
        address agentPayoutWallet
    );

    event AdPayment(
        string indexed adId,
        address indexed advertiser,
        uint256 amount
    );

    event SubscriptionPayment(
        string indexed subId,
        address indexed subscriber,
        uint256 amount
    );

    event PlatformWalletUpdated(
        address indexed oldWallet,
        address indexed newWallet
    );

    constructor(
        address _usdc,
        address _agentRegistry,
        address _platformWallet
    ) Ownable(msg.sender) {
        require(_usdc != address(0), "Invalid USDC");
        require(_agentRegistry != address(0), "Invalid registry");
        require(_platformWallet != address(0), "Invalid wallet");

        usdc = IERC20(_usdc);
        agentRegistry = IAgentRegistry(_agentRegistry);
        platformWallet = _platformWallet;
    }

    /* ========== TIPS ========== */

    function tipAgent(string calldata agentId, uint256 amount)
        external
        nonReentrant
    {
        require(amount > 0, "Amount must be positive");

        bytes32 key = keccak256(abi.encodePacked(agentId));
        uint256 tokenId = agentRegistry.agentKeyToTokenId(key);

        uint256 agentShare = 0;
        uint256 platformShare = amount;
        address payoutWallet = address(0);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        if (tokenId > 0) {
            payoutWallet = agentRegistry.payoutWallets(tokenId);
            require(payoutWallet != address(0), "Invalid payout wallet");

            agentShare = (amount * AGENT_TIP_SHARE) / BASIS_POINTS;
            platformShare = amount - agentShare;

            usdc.safeTransfer(payoutWallet, agentShare);
        }

        usdc.safeTransfer(platformWallet, platformShare);

        emit TipSent(
            agentId,
            msg.sender,
            amount,
            agentShare,
            platformShare,
            payoutWallet
        );
    }

    /* ========== ADS ========== */

    function payAd(string calldata adId, uint256 amount)
        external
        nonReentrant
    {
        require(amount > 0, "Amount must be positive");
        require(bytes(adId).length > 0, "Invalid ad ID");

        usdc.safeTransferFrom(msg.sender, platformWallet, amount);

        emit AdPayment(adId, msg.sender, amount);
    }

    /* ========== SUBSCRIPTIONS ========== */

    function paySubscription(string calldata subId, uint256 amount)
        external
        nonReentrant
    {
        require(amount > 0, "Amount must be positive");
        require(bytes(subId).length > 0, "Invalid sub ID");

        usdc.safeTransferFrom(msg.sender, platformWallet, amount);

        emit SubscriptionPayment(subId, msg.sender, amount);
    }

    /* ========== ADMIN ========== */

    function updatePlatformWallet(address newWallet)
        external
        onlyOwner
    {
        require(newWallet != address(0), "Invalid wallet");

        address old = platformWallet;
        platformWallet = newWallet;

        emit PlatformWalletUpdated(old, newWallet);
    }

    function emergencyWithdraw(address token, uint256 amount)
        external
        onlyOwner
    {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
