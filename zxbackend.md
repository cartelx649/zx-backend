 **Business & Technical Model Document**

---

## **1\. Project Overview**

**Zx** is a Web3-based network growth and ROI platform built on BNB Smart Chain using Tether (BEP-20).

The platform is designed around:

* ROI-based earning  
* Referral-based network growth  
* Treasury-based capital management  
* Cycle-based earning system  
* Re-top up activation model

Unlike traditional on-chain staking models, Croix 2X follows a **Treasury Model**, where all user deposits are transferred to a company treasury wallet for capital deployment, trading, and liquidity generation. User payouts are processed separately through a dedicated payout wallet.

---

# **2\. Core Platform Flow**

The complete platform works in this sequence:

**Register → Deposit → Earn ROI → Earn Network Income → Reach Cap → Re-Top Up → Start New Cycle**

---

# **3\. Blockchain Infrastructure**

### **Network**

BNB Smart Chain

### **Token Used**

Tether (BEP-20)

### **Wallet Support**

* MetaMask  
* Trust Wallet

### **Smart Contract Language**

Solidity

---

# **4\. User Registration System**

Every user joins through a referral link.

When user joins:

System stores:

* Wallet Address  
* Sponsor Wallet Address  
* Referral ID  
* Joining Date  
* Current Package  
* Current Cycle  
* Team Structure

### **Important Rule:**

Sponsor/upline relation is permanent.

Once linked, it cannot be changed.

---

# 

# 

# **5\. Deposit System**

## **How Deposit Works**

When user wants to activate account:

### **Step 1:**

User connects wallet.

### **Step 2:**

User approves USDT spending.

### **Step 3:**

User deposits package amount.

Example:

* 100 USDT  
* 500 USDT  
* 1000 USDT

### **Step 4:**

System records deposit.

System stores:

* Deposit Amount  
* Deposit Date  
* Package Type  
* ROI Slab  
* Total Cap  
* Cycle Number

---

## 

## 

## **Deposit Fund Flow**

All deposits go to:

### **Treasury Wallet**

Purpose:

* Capital deployment  
* Trading  
* Profit generation  
* Treasury management

Deposit does NOT remain in payout wallet.

---

# **6\. ROI Model**

Croix 2X does NOT use fixed ROI.

It uses **ROI Slab Model**.

Example slabs:

| Package | Monthly ROI |
| ----- | ----- |
| 100–499 USDT | Admin configurable |
| 500–999 USDT | Admin configurable |
| 1000+ USDT | Admin configurable |

Admin can modify slabs from dashboard.

---

## 

## 

## 

## **ROI Rule**

User earns monthly ROI until **2X** is completed.

Example:

If user deposits:

100 USDT

Target ROI:

200 USDT

Once 200 USDT achieved:

ROI stops.

---

# **7\. Direct Referral Income**

Direct sponsor receives:

## **5% Direct Commission**

Example:

If referral deposits:

500 USDT

Sponsor receives:

25 USDT

This income is instantly credited.

---

# 

# 

# **8\. 20-Level ROI Override Income**

This is NOT matching income.

This is **ROI Override Income**.

Whenever downline receives monthly ROI:

Upline receives override income.

Maximum:

20 Levels.

Example structure:

| Level | Percentage |
| ----- | ----- |
| Level 1 | Admin configurable |
| Level 2 | Admin configurable |
| Level 3 | Admin configurable |
| ... | ... |
| Level 20 | Admin configurable |

Admin can manage percentages.

---

# 

# 

# 

# **9\. Total Income Cap**

Every user has:

## **3X Capping**

Example:

Deposit \= 100 USDT

Maximum earning \= 300 USDT

This includes:

* ROI Income  
* Direct Income  
* Level Override Income

Once 3X achieved:

All incomes stop.

---

# **10\. Re-Top Up Model**

When user completes 3X:

Account becomes inactive.

User stops receiving:

* ROI  
* Direct Income  
* Level Income

To continue:

User must do:

## **Re-Top Up**

Rules:

User must deposit:

* Same package OR  
* Higher package

Example:

Previous Package:  
100 USDT

Minimum Re-top:  
100 USDT

After re-top up:

System creates:

* New earning cycle  
* New ROI target  
* New 3X cap

---

# **11\. Withdrawal System**

Withdrawals open:

## **Every Month on 4th**

---

## **Monthly Process**

System calculates:

Platform total payout:

Includes:

* ROI  
* Direct income  
* Level override income

Example:

Total monthly payout:

100,000 USDT

---

## **Admin Action**

Admin manually transfers liquidity into:

## **Payout Wallet**

---

## **User Withdrawal**

User clicks withdraw.

System verifies:

* User active?  
* Withdrawal window open?  
* Cap not exceeded?

If approved:

Instant USDT transfer to user wallet.

---

# 

# **12\. Wallet Architecture**

## **Wallet 1 — Treasury Wallet**

Purpose:

* Receive deposits  
* Trading capital  
* Treasury operations

---

## **Wallet 2 — Payout Wallet**

Purpose:

* Monthly liquidity  
* User withdrawals

---

# **13\. User Dashboard Features**

Users should see:

* Wallet Connect  
* Deposit Packages  
* ROI Progress  
* Total Earned  
* Remaining Cap  
* Referral Link  
* Team Tree  
* Direct Income  
* Level Income  
* Active Cycle  
* Re-Top Up Button  
* Withdrawal History

---

# **14\. Admin Dashboard Features**

Admin should control:

* Total Users  
* Active Users  
* Inactive Users  
* Total Deposits  
* Total Withdrawals  
* Total Payouts  
* Treasury Wallet Status  
* Payout Wallet Status  
* ROI Slabs  
* Level Percentages  
* Withdrawal Window  
* Re-top Users

---

# **15\. Technology Stack**

### **Smart Contracts**

* Solidity  
* Hardhat

### **Frontend**

* React  
  OR  
* Next.js

### **Backend**

* Node.js

---

# 

# **16\. Security Features**

Platform should include:

* Admin Access Control  
* Wallet Signature Validation  
* Transaction Logs  
* Event Tracking  
* Emergency Pause  
* Withdrawal Validation  
* Anti Double Claim Protection

---

# **17\. Final Business Logic Summary**

User joins → Deposits USDT → Deposit goes to Treasury → User earns ROI \+ Network Income → User reaches 3X → Account stops → User re-top ups → New cycle begins.

