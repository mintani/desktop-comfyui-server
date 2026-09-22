# Fonts

The latin subsets of the two families the UI uses, exactly as Google Fonts
serves them, so the page never has to fetch anything from a third party.

| File                   | Family         | Weight  | Source                                                  |
| ---------------------- | -------------- | ------- | ------------------------------------------------------- |
| `poppins-400.woff2`    | Poppins        | 400     | https://fonts.google.com/specimen/Poppins               |
| `poppins-500.woff2`    | Poppins        | 500     | https://fonts.google.com/specimen/Poppins               |
| `poppins-600.woff2`    | Poppins        | 600     | https://fonts.google.com/specimen/Poppins               |
| `jetbrains-mono.woff2` | JetBrains Mono | 400–500 | https://fonts.google.com/specimen/JetBrains+Mono        |

Both families are licensed under the SIL Open Font License, Version 1.1
(https://openfontlicense.org). The font software may be used, studied,
modified and redistributed freely as long as it is not sold by itself; the
license text and copyright notices are in each family's upstream repository:

- Poppins — Copyright 2020 The Poppins Project Authors,
  https://github.com/itfoundry/Poppins
- JetBrains Mono — Copyright 2020 The JetBrains Mono Project Authors,
  https://github.com/JetBrains/JetBrainsMono

The `@font-face` rules that load them are at the top of `../style.css`.
