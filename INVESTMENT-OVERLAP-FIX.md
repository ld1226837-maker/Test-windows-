# R23 + Bills & printing + investment statement overlap fix

Applied on top of truff-*-r23:
1. bills-printing-{windows,android}.patch (Bills & printing card, expense voucher, investment statement, own folders)
2. investment-statement-overlap-fix-{windows,android}.patch (src/lib/receipt.ts)
   - labels in voucher/statement detail rows shrink to fit their column (no more "Statement No." running into the value on 58 mm rolls / large text)
   - the ": " separator is drawn separately so it can never be stranded on its own line
