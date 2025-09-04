@spawn
Feature: internationalization

  Scenario: view available languages
    When I run cucumber-js with `--i18n-languages`
    Then the output contains the text:
      """
      ISO 639-1 | ENGLISH  NAME        | NATIVE NAME
      af        | Afrikaans            | Afrikaans
      """
    Then the output contains the text:
      """
      ja        | Japanese            | 日本語
      """

  Scenario: invalid iso code
    When I run cucumber-js with `--i18n-keywords XX`
    Then the error output contains the text:
      """
      Unsupported ISO 639-1: XX
      """
    And it fails
