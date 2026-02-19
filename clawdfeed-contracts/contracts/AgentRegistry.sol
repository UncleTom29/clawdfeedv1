// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AgentRegistry is ERC721, Ownable {
    uint256 private _tokenIds;

    struct AgentReservation {
        bytes32 reservationHash;
        uint256 expiresAt;
        bool claimed;
        address authorizedWallet;
    }

    // keccak256(agentId) => reservation
    mapping(bytes32 => AgentReservation) public reservations;

    // tokenId => agentKey
    mapping(uint256 => bytes32) public tokenToAgentKey;

    // agentKey => tokenId
    mapping(bytes32 => uint256) public agentKeyToTokenId;

    // tokenId => metadata URI
    mapping(uint256 => string) private _tokenURIs;

    // tokenId => payout wallet
    mapping(uint256 => address) public payoutWallets;

    // verification flags
    mapping(uint256 => bool) public isVerified;
    mapping(uint256 => bool) public isFullyVerified;

    event AgentReserved(
        string indexed agentId,
        bytes32 reservationHash,
        uint256 expiresAt,
        address indexed authorizedWallet
    );

    event AgentMinted(
        string indexed agentId,
        uint256 indexed tokenId,
        address indexed owner,
        address payoutWallet
    );

    event PayoutWalletUpdated(
        uint256 indexed tokenId,
        address indexed oldWallet,
        address indexed newWallet
    );

    event VerificationUpdated(
        uint256 indexed tokenId,
        bool isVerified,
        bool isFullyVerified
    );

    constructor() ERC721("ClawdFeed Agent", "CLAWDAGENT") Ownable(msg.sender) {}

    function _agentKey(string calldata agentId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(agentId));
    }

    /* ========== RESERVATION ========== */

    function reserveAgent(
        string calldata agentId,
        bytes32 reservationHash,
        uint256 expiry,
        address authorizedWallet
    ) external {
        require(bytes(agentId).length > 0, "Invalid agent ID");
        require(reservationHash != bytes32(0), "Invalid reservation hash");
        require(expiry > block.timestamp, "Expiry must be future");
        require(authorizedWallet != address(0), "Invalid wallet");

        bytes32 key = _agentKey(agentId);

        require(agentKeyToTokenId[key] == 0, "Already minted");
        require(!reservations[key].claimed, "Already claimed");

        require(
            msg.sender == owner() || msg.sender == authorizedWallet,
            "Not authorized"
        );

        reservations[key] = AgentReservation({
            reservationHash: reservationHash,
            expiresAt: expiry,
            claimed: false,
            authorizedWallet: authorizedWallet
        });

        emit AgentReserved(agentId, reservationHash, expiry, authorizedWallet);
    }

    /* ========== MINT ========== */

    function mintReservedAgent(
        string calldata agentId,
        string calldata metadataURI,
        address desiredPayoutWallet
    ) external {
        require(bytes(agentId).length > 0, "Invalid agent ID");
        require(bytes(metadataURI).length > 0, "Invalid metadata URI");
        require(desiredPayoutWallet != address(0), "Invalid payout wallet");

        bytes32 key = _agentKey(agentId);
        AgentReservation storage reservation = reservations[key];

        require(reservation.reservationHash != bytes32(0), "No reservation");
        require(!reservation.claimed, "Already claimed");
        require(block.timestamp <= reservation.expiresAt, "Expired");
        require(agentKeyToTokenId[key] == 0, "Already minted");
        require(
            msg.sender == reservation.authorizedWallet,
            "Not authorized"
        );

        reservation.claimed = true;

        _tokenIds++;
        uint256 tokenId = _tokenIds;

        _safeMint(msg.sender, tokenId);

        tokenToAgentKey[tokenId] = key;
        agentKeyToTokenId[key] = tokenId;
        _tokenURIs[tokenId] = metadataURI;
        payoutWallets[tokenId] = desiredPayoutWallet;

        emit AgentMinted(agentId, tokenId, msg.sender, desiredPayoutWallet);

        delete reservations[key];
    }

    /* ========== ADMIN ========== */

    function setVerificationStatus(
        uint256 tokenId,
        bool _isVerified,
        bool _isFullyVerified
    ) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");

        isVerified[tokenId] = _isVerified;
        isFullyVerified[tokenId] = _isFullyVerified;

        emit VerificationUpdated(tokenId, _isVerified, _isFullyVerified);
    }

    /* ========== OWNER FUNCTIONS ========== */

    function updatePayoutWallet(uint256 tokenId, address newWallet) external {
        require(ownerOf(tokenId) == msg.sender, "Not owner");
        require(newWallet != address(0), "Invalid wallet");

        address oldWallet = payoutWallets[tokenId];
        payoutWallets[tokenId] = newWallet;

        emit PayoutWalletUpdated(tokenId, oldWallet, newWallet);
    }

    /* ========== VIEWS ========== */

    function isAgentVerified(string calldata agentId) external view returns (bool) {
        uint256 tokenId = agentKeyToTokenId[_agentKey(agentId)];
        if (tokenId == 0) return false;
        return isVerified[tokenId];
    }

    function isAgentFullyVerified(string calldata agentId) external view returns (bool) {
        uint256 tokenId = agentKeyToTokenId[_agentKey(agentId)];
        if (tokenId == 0) return false;
        return isFullyVerified[tokenId];
    }

    function getPayoutWallet(string calldata agentId) external view returns (address) {
        uint256 tokenId = agentKeyToTokenId[_agentKey(agentId)];
        require(tokenId != 0, "Agent not minted");
        return payoutWallets[tokenId];
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return _tokenURIs[tokenId];
    }

    /* ========== SOULBOUND ========== */

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = super._update(to, tokenId, auth);

        if (from != address(0) && to != address(0)) {
            revert("Soulbound: non-transferable");
        }

        return from;
    }
}
