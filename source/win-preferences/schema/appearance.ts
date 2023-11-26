import { trans } from '@common/i18n-renderer'
import { PreferencesGroups, type PreferencesFieldset } from '../App.vue'

export function getAppearanceFields (): PreferencesFieldset[] {
  return [
    {
      title: trans('Dark mode'),
      group: PreferencesGroups.Appearance,
      help: '', // TODO,
      fields: [
        {
          // TODO: Move to title bar
          type: 'checkbox',
          label: trans('Dark mode'),
          model: 'darkMode'
        },
        {
          type: 'radio',
          label: trans('Automatically switch to dark mode'),
          model: 'autoDarkMode',
          options: {
            off: trans('Off'),
            schedule: trans('Schedule'),
            system: trans('Follow Operating System')
          }
        },
        {
          // TODO: All of this one line
          type: 'time',
          label: trans('Start dark mode at'),
          model: 'autoDarkModeStart',
          inline: true
        },
        {
          type: 'time',
          label: trans('End dark mode at'),
          model: 'autoDarkModeEnd',
          inline: true
        }
      ]
    },
    {
      title: trans('Theme'),
      group: PreferencesGroups.Appearance,
      help: '', // TODO
      fields: [
        {
          type: 'theme',
          model: 'display.theme',
          label: trans('Here you can choose the theme for the app.'),
          options: {
            berlin: {
              textColor: 'white',
              backgroundColor: '#1cb27e',
              name: 'Berlin',
              fontFamily: 'inherit',
              description: 'An all-time classic: This theme has been part of Zettlr since the very beginning. A modern theme featuring the signatory green color and a sans-serif font.'
            },
            frankfurt: {
              textColor: 'white',
              backgroundColor: '#1d75b3',
              name: 'Frankfurt',
              fontFamily: 'Crimson',
              description: 'In line with the spirit of the time-honoured Frankfurt School, this theme features a mature serif font paired with royal blue.'
            },
            bielefeld: {
              textColor: 'black',
              backgroundColor: '#ffffdc',
              name: 'Bielefeld',
              fontFamily: 'Liberation Mono',
              description: 'With its mellow orange and a monospaced font, this theme gets you as reminiscent of Niklas Luhmann\'s heyday as possible.'
            },
            'karl-marx-stadt': {
              textColor: 'white',
              backgroundColor: '#dc2d2d',
              name: 'Karl-Marx-Stadt',
              fontFamily: 'inherit',
              description: 'City names change, but their spirit remains: A forceful red complements this theme\'s progressive appeal and sans-serif font.'
            },
            bordeaux: {
              textColor: '#dc2d2d',
              backgroundColor: '#fffff8',
              name: 'Bordeaux',
              fontFamily: 'Inconsolata',
              description: 'Design made in France: Enjoy writing with this theme\'s unagitated colors and beautiful monospaced font.'
            }
          }
        }
      ]
    },
    {
      title: trans('Toolbar options'),
      group: PreferencesGroups.Appearance,
      help: '', // TODO
      fields: [
        // TODO: Label: Left section buttons
        {
          type: 'checkbox',
          label: trans('Display "Open Preferences" button'),
          model: 'displayToolbarButtons.showOpenPreferencesButton'
        },
        {
          type: 'checkbox',
          label: trans('Display "New File" button'),
          model: 'displayToolbarButtons.showNewFileButton'
        },
        {
          type: 'checkbox',
          label: trans('Display "Previous File" button'),
          model: 'displayToolbarButtons.showPreviousFileButton'
        },
        {
          type: 'checkbox',
          label: trans('Display "Next File" button'),
          model: 'displayToolbarButtons.showNextFileButton'
        },
        // TODO: Label: Center section buttons
        {
          type: 'checkbox',
          label: trans('Display readability button'),
          model: 'displayToolbarButtons.showToggleReadabilityButton'
        },
        {
          type: 'checkbox',
          label: trans('Display "Insert Comment" button'),
          model: 'displayToolbarButtons.showMarkdownCommentButton'
        },
        {
          type: 'checkbox',
          label: trans('Display link button'),
          model: 'displayToolbarButtons.showMarkdownLinkButton'
        },
        {
          type: 'checkbox',
          label: trans('Display image button'),
          model: 'displayToolbarButtons.showMarkdownImageButton'
        },
        {
          type: 'checkbox',
          label: trans('Display task list button'),
          model: 'displayToolbarButtons.showMarkdownMakeTaskListButton'
        },
        {
          type: 'checkbox',
          label: trans('Display "Insert Table" button'),
          model: 'displayToolbarButtons.showInsertTableButton'
        },
        {
          type: 'checkbox',
          label: trans('Display "Insert Footnote" button'),
          model: 'displayToolbarButtons.showInsertFootnoteButton'
        },
        // TODO: Label: Right section buttons
        {
          type: 'checkbox',
          label: trans('Display document info'),
          model: 'displayToolbarButtons.showDocumentInfoText'
        },
        {
          type: 'checkbox',
          label: trans('Display Pomodoro-timer'),
          model: 'displayToolbarButtons.showPomodoroButton'
        }
      ]
    },
    {
      title: trans('Status bar'),
      group: PreferencesGroups.Appearance,
      help: '', // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Show statusbar'),
          model: 'editor.showStatusbar'
        }
        // TODO: Add field for single Button, label "Custom CSS", button "Open CSS editor"
      ]
    }
  ]
}
