import type { GlobalThemeOverrides } from 'naive-ui'

const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"

const componentOverrides: GlobalThemeOverrides = {
  Button: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadiusSmall: '6px',
    borderRadiusMedium: '6px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Input: {
    heightSmall: '30px',
    heightMedium: '34px',
    borderRadius: '6px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px',
    paddingSmall: '0 10px',
    paddingMedium: '0 10px'
  },
  Radio: {
    buttonHeightSmall: '30px',
    buttonHeightMedium: '32px',
    buttonBorderRadius: '6px',
    fontSizeSmall: '13px',
    fontSizeMedium: '13px'
  },
  Select: {
    menuBoxShadow: 'var(--shadow-float)',
    peers: {
      InternalSelection: {
        textColor: 'var(--text-1)',
        fontSizeMedium: '13px'
      }
    }
  },
  Switch: {
    railHeightMedium: '20px',
    railWidthMedium: '38px',
    buttonHeightMedium: '16px',
    buttonWidthMedium: '16px'
  }
}

export const teahouseLightThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#4e79af',
    primaryColorHover: '#416b9f',
    primaryColorPressed: '#365c8b',
    primaryColorSuppl: '#4e79af',
    infoColor: '#4e79af',
    infoColorHover: '#416b9f',
    infoColorPressed: '#365c8b',
    infoColorSuppl: '#4e79af',
    textColorBase: '#293241',
    textColor1: '#293241',
    textColor2: '#546479',
    textColor3: '#637185',
    placeholderColor: '#687586',
    borderColor: '#d5deea',
    dividerColor: '#e5e9f0',
    bodyColor: '#ffffff',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    inputColor: '#ffffff',
    hoverColor: '#eef2f7',
    pressedColor: '#e5edf9',
    fontFamily,
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontSize: '13px',
    heightSmall: '30px',
    heightMedium: '34px'
  }
}

export const teahouseDarkThemeOverrides: GlobalThemeOverrides = {
  ...componentOverrides,
  common: {
    primaryColor: '#5d8fd0',
    primaryColorHover: '#77a3dd',
    primaryColorPressed: '#4e7db9',
    primaryColorSuppl: '#5d8fd0',
    infoColor: '#5d8fd0',
    infoColorHover: '#77a3dd',
    infoColorPressed: '#4e7db9',
    infoColorSuppl: '#5d8fd0',
    textColorBase: '#e6edf6',
    textColor1: '#e6edf6',
    textColor2: '#b2bfd0',
    textColor3: '#9ba9bc',
    placeholderColor: '#8290a3',
    borderColor: '#40516a',
    dividerColor: '#334154',
    bodyColor: '#171e29',
    cardColor: '#202a38',
    modalColor: '#171e29',
    popoverColor: '#202a38',
    inputColor: '#202a38',
    hoverColor: '#293647',
    pressedColor: '#2b4263',
    fontFamily,
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontSize: '13px',
    heightSmall: '30px',
    heightMedium: '34px'
  }
}
